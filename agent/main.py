"""LiveKit voice agent: the 311 intake line for the City of Berkeley.

Run it with:
    uv run python -m agent.main console   # terminal mic, fastest to test
    uv run python -m agent.main dev       # joins rooms created by the dashboard

Design notes
------------
The agent opens a case *early*, as soon as it knows roughly what the problem
is, then patches fields onto it as the caller supplies them. That is
deliberate: it makes the dashboard show a live case that fills in during the
conversation instead of one row appearing at hangup. Repeated partial updates
are cheap because every write is a PATCH of only the fields that moved, and the
backend logs and broadcasts exactly the fields that changed.

The agent also reports things about the call that only it knows: which *phase*
of the call it is in and a one-line *activity* describing what it is doing, so
staff watching the board can see the conversation progressing rather than just
its result; how *confident* it is in the category it picked, so a shaky guess
leaves the case visibly unclassified instead of quietly mis-routed; and how the
caller *sounds*, so a supervisor can step into a call that is going badly while
it is still up.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    RunContext,
    UserInputTranscribedEvent,
    cli,
    function_tool,
)
from livekit.plugins import openai
from openai.types.realtime import AudioTranscription

from agent.backend import CaseAPI

load_dotenv()
logger = logging.getLogger("effigov-agent")

IssueType = Literal[
    "missed_collection",
    "pothole",
    "streetlight",
    "noise_complaint",
    "water_leak",
    "graffiti",
    "other",
]

# The prompt and the code both use this, so the agent cannot be told to open
# with one line while the session speaks another.
GREETING = "Berkeley 311, this is Emma. How can I help you today?"

# One short present-tense line per phase, for the supervisor console. The agent
# can say something more specific; this is what it falls back to so the line is
# never stale or empty just because nobody thought to set it.
ACTIVITY_BY_PHASE = {
    "greeting": "Greeting the caller.",
    "gathering": "Gathering details about the problem.",
    "filed": "Confirming the report and taking contact details.",
    "wrapping": "Wrapping up and reading the case number back.",
    "ended": "Call ended.",
}

# The console renders this on one line beside the phase badge.
ACTIVITY_MAX = 60

# The realtime model auto-detects the transcription language when it is not
# told one, and it guesses on short or accented audio: a caller saying "uh,
# Thomas Lu" came back as Korean and landed in the transcript that way. This
# is an English-language city line, so the language is pinned rather than
# inferred per utterance. The model is the plugin's own default for this
# version; only the language is being changed.
TRANSCRIPTION = AudioTranscription(model="gpt-4o-mini-transcribe", language="en")


def short_activity(text: str) -> str:
    """Trim an activity line to something that fits on the console's one line."""
    text = " ".join(text.split())
    return text if len(text) <= ACTIVITY_MAX else text[: ACTIVITY_MAX - 1].rstrip() + "\u2026"


INSTRUCTIONS = f"""
You are Emma, the automated intake line for the City of Berkeley's 311 service
center. You speak with residents by phone.

Style: warm, brisk, plain language. One question at a time. Never read a list
of options aloud. Keep every turn under about two sentences. You are on a voice
call, so no markdown, no bullet points, and spell out numbers naturally.

Your job is one of two things.

1. Taking a new report. Get the problem and the location first, because the
   city tracks one case per problem, not one per caller. As soon as you know
   roughly what and where, call `file_report`. That tool tells you whether this
   is a new case or a problem already reported by someone else, and you must
   tell the caller which it was. Then keep talking and call `update_request`
   each time you learn something new: their name, their callback number, a
   better location, a better description. Read the case number back once, near
   the end, digit by digit.

2. Checking on an existing report. Ask for the case number or the phone number
   they used and call `look_up_request`. You may give the status straight away:
   that is public to anyone who has the case number. But you do not yet know
   who you are talking to. Anyone can read a case number off a neighbour's
   letter, and the person who filed it is a different resident with a name and
   a phone number on file.

   So before you treat the caller as that reporter, verify them:

   a. Ask whether their callback number ends in the four digits the lookup gave
      you: "does your callback number end in 0188?". Those four digits are the
      only part of the number you have and the only part you may ever say.
   b. If they confirm, ask whether you are speaking with the name on file. Do
      not say that name before the digits check passes.
   c. Call `confirm_caller_identity` with what they told you.

   If they are not that person - wrong digits, wrong name, or they say no -
   they are a NEW reporter on an existing incident, which is exactly what the
   city wants to record. Take their own name and callback number and call
   `add_reporter_to_case`. Their report joins that case, the incident gains
   corroboration, and the city can call *them* back.

Rules:
- Never say a stored phone number out loud. You are given the last four digits
  of a reporter's number and nothing more, on purpose. Never guess, spell out,
  or confirm the rest of it, and never repeat a number back to a caller who has
  not been verified.
- Confirm phone numbers and locations by repeating them back before you save.
- Once you have the street address, ask one more question: whereabouts on the
  street the problem actually is. Save the answer as `location_detail` on
  `update_request`. A crew given a block and no landmark drives past it twice.
- If the caller describes an immediate danger to people, such as a sparking or
  downed power line, a gas smell, active flooding, or a blocked fire exit, call
  `escalate_to_human` right away with a one line reason, tell the caller a
  person is being brought in, and tell them to call 911 if anyone is in danger.
- Never invent a case number, a status, or a repair timeline. If you do not
  know, say you do not know.
- Report your category confidence honestly. If the caller has been vague, a low
  number is the correct answer and leaves the case visibly unclassified for a
  human. Claiming certainty you do not have routes a crew to the wrong place.
- Call `set_call_phase` as the conversation moves: `gathering` once you start
  collecting details, `wrapping` when you begin reading the case number back.
  Pass an `activity` line with it, one short present-tense sentence under about
  sixty characters saying what you are doing, such as "Handling request about
  pothole on Oak Street." A supervisor reads that line off the console.
- Call `set_sentiment` when the caller's tone clearly shifts, negative for a
  frustrated, upset, or distressed caller and positive once they are reassured.
  A supervisor watching the console needs to see an unhappy caller while the
  call is still up, not afterwards in a transcript.
- When the caller says they have nothing more to add, close out: thank them by
  name, say who is handling it, invite them to call back, and then call
  `end_call` so the line hangs up instead of sitting open in silence.
- Open with: "{GREETING}"
"""


@dataclass
class CallState:
    """Everything the agent needs to remember for the duration of one call."""

    api: CaseAPI
    call_id: int | None = None
    case_id: int | None = None
    case_number: str | None = None
    report_id: int | None = None
    phase: str = "greeting"
    activity: str | None = None
    sentiment: str = "neutral"
    caller_name: str | None = None
    collected: dict[str, str] = field(default_factory=dict)
    # Set by ``look_up_request``. The name on file for the case the caller
    # named, and the last four digits of that reporter's number - the only part
    # of it the agent is ever given. ``identity_verified`` stays False until
    # the caller has matched both, and gates everything that would treat them
    # as that reporter.
    on_file: dict[str, str | None] | None = None
    identity_verified: bool = False
    # Whether ``set_status`` was called during this call. Hangup parks a case
    # the agent never ruled on; a case it *did* rule on keeps that ruling.
    status_set: bool = False
    # Set by the entrypoint, which is the only place that holds the room.
    request_hangup: Callable[[], None] | None = None

    async def set_phase(self, phase: str, activity: str | None = None) -> None:
        """Tell the backend where the call has got to, once per transition.

        The activity line rides along, so the console never shows a phase that
        moved on next to a sentence describing what the agent was doing before.
        """
        if self.call_id is None:
            return
        if self.phase == phase:
            # Same phase, new words for it. Still worth saying.
            if activity:
                await self.set_activity(activity)
            return
        self.phase = phase
        line = short_activity(activity or ACTIVITY_BY_PHASE.get(phase, ""))
        self.activity = line or None
        await self.api.set_phase(self.call_id, phase, activity_line=self.activity)

    async def set_activity(self, activity: str) -> None:
        """Update the one-line "what is happening now" without changing phase."""
        line = short_activity(activity)
        if self.call_id is None or not line or self.activity == line:
            return
        self.activity = line
        await self.api.update_call(self.call_id, activity_line=line)

    async def set_sentiment(self, sentiment: str) -> None:
        if self.call_id is None or self.sentiment == sentiment:
            return
        self.sentiment = sentiment
        await self.api.update_call(self.call_id, sentiment=sentiment)

    async def set_caller_name(self, name: str) -> None:
        """Put the caller's name on the call itself, not only on the report.

        The console lists live calls. Making it join through a report to learn
        who is on the line would mean showing nobody until a report exists.
        """
        if self.call_id is None or self.caller_name == name:
            return
        self.caller_name = name
        await self.api.update_call(self.call_id, caller_name=name)


class IntakeAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    # -- tools ------------------------------------------------------------

    @function_tool
    async def file_report(
        self,
        ctx: RunContext[CallState],
        issue_type: IssueType,
        location: str,
        description: str,
        issue_type_confidence: float,
    ) -> str:
        """File the caller's report as soon as you know the problem and roughly where it is.

        The backend decides whether this opens a new case or attaches to one
        another resident already reported. Do not wait for the caller's name or
        phone number; collect those afterwards with update_request.

        Args:
            issue_type: Best guess at the category of the problem.
            location: Where the problem is, in the caller's words. A street
                address or an intersection, not their mailing address.
            description: One or two sentences in the caller's own words.
            issue_type_confidence: How sure you are of the category, from 0.0 to
                1.0. Be honest. Use a low number when the caller was vague, said
                something that fits more than one category, or you are guessing
                from a single word. Below 0.6 the city deliberately leaves the
                case unclassified for a human rather than routing it wrongly,
                and you can raise it later with update_request once you know
                more. Overstating this sends a crew to the wrong department.
        """
        state = ctx.userdata
        if state.case_id is not None:
            return f"A report is already open on this call: {state.case_number}."

        await state.set_phase(
            "gathering", f"Taking a report about {issue_type.replace('_', ' ')} at {location}."
        )
        result = await state.api.file_report(
            issue_type=issue_type,
            issue_type_confidence=issue_type_confidence,
            location=location,
            description=description,
            call_id=state.call_id,
        )
        case, report = result["case"], result["report"]
        state.case_id = case["id"]
        state.case_number = case["case_number"]
        state.report_id = report["id"]

        if state.call_id is not None:
            await state.api.update_call(
                state.call_id, case_id=case["id"], report_id=report["id"]
            )
        await state.set_phase(
            "filed", f"Filed {state.case_number}, taking contact details."
        )

        logger.info(
            "filed report %s on case %s (merged=%s)",
            report["id"],
            state.case_number,
            result["merged"],
        )

        if case.get("issue_type") is None:
            return (
                f"Opened case {case['case_number']}, but your confidence of "
                f"{issue_type_confidence} was too low to categorise it, so it is "
                f"waiting on a human and is not routed to a department yet. Ask one "
                f"more question to pin the category down, then call update_request "
                f"with a higher confidence. Still collect their name and number."
            )
        if result["merged"]:
            return (
                f"This problem was already reported. Their report was added to existing "
                f"case {case['case_number']}, which now has {case['report_count']} reports "
                f"and is with {case['department'].replace('_', ' ')}. Tell the caller the "
                f"city already knows about it, that you have added their report, and give "
                f"them that case number. Then still collect their name and callback number."
            )
        return (
            f"Opened new case {case['case_number']}, routed to "
            f"{case['department'].replace('_', ' ')}. Now collect the caller's name and "
            f"callback number and save them with update_request."
        )

    @function_tool
    async def update_request(
        self,
        ctx: RunContext[CallState],
        caller_name: str | None = None,
        phone: str | None = None,
        location: str | None = None,
        location_detail: str | None = None,
        description: str | None = None,
        issue_type: IssueType | None = None,
        issue_type_confidence: float | None = None,
    ) -> str:
        """Save newly learned details. Call this every time the caller tells you something.

        Args:
            caller_name: Caller's full name, as they said it.
            phone: Callback number, digits only.
            location: A corrected or more precise location for the problem.
            location_detail: Where exactly on that street the problem is, once
                you have the address. Ask for it: "whereabouts on the street is
                it?". One short phrase in the caller's own words, such as
                "right lane near the crosswalk, curb side" or "back alley
                behind the pharmacy". The address gets a crew to the block; this
                is what stops them driving past the thing twice.
            issue_type: A corrected category, if the first guess was wrong.
            issue_type_confidence: How sure you are of that category, 0.0 to 1.0.
                Required whenever you pass issue_type. Report it honestly: below
                0.6 the city leaves the case unclassified on purpose. This is how
                a case you filed as unclassified gets categorised and routed once
                the caller tells you enough to be sure.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Nothing is open yet. Call file_report first."

        # A case reached through look_up_request has no report of this caller's
        # on it, so there is nothing here to write their name or number onto.
        # Saying so beats accepting them and dropping them on the floor - and
        # writing them onto the reporter already on file would overwrite a
        # resident's details with a stranger's.
        if state.report_id is None and (caller_name or phone):
            return (
                "This caller has no report on this case yet, so their name and number "
                "have nowhere to go. If they are the reporter on file, their details are "
                "already recorded. If they are not, call add_reporter_to_case with their "
                "own name and number instead."
            )

        if phone:
            phone = "".join(ch for ch in phone if ch.isdigit())

        if caller_name:
            await state.set_caller_name(caller_name)

        if state.report_id is not None and (caller_name or phone or description):
            await state.api.update_report(
                state.report_id,
                reporter_name=caller_name,
                reporter_phone=phone,
                description=description,
            )

        if location or location_detail or description or issue_type:
            await state.api.update_case(
                state.case_id,
                location=location,
                location_detail=location_detail,
                description=description,
                issue_type=issue_type,
                issue_type_confidence=issue_type_confidence,
            )

        saved = {
            "caller_name": caller_name,
            "phone": phone,
            "location": location,
            "location_detail": location_detail,
            "description": description,
            "issue_type": issue_type,
        }
        state.collected.update({k: v for k, v in saved.items() if v})
        logger.info("updated %s: %s", state.case_number, sorted(state.collected))
        return f"Saved. Case {state.case_number} is up to date."

    @function_tool
    async def look_up_request(self, ctx: RunContext[CallState], identifier: str) -> str:
        """Find an existing case by case number or by the caller's phone number.

        Finding the case does NOT tell you who is on the line. The status is
        safe to give out, but the caller is not the reporter until you have
        verified them the way this tool's answer tells you to, and until then
        you must not treat anything on file as theirs.

        Args:
            identifier: A case number like SR-123456, or a ten digit phone number.
        """
        state = ctx.userdata
        case = await state.api.lookup_case(identifier)
        if case is None:
            return "No case found for that. Offer to take a new report."

        state.case_id = case["id"]
        state.case_number = case["case_number"]
        state.on_file = case.get("reporter")
        state.identity_verified = False
        if state.call_id is not None:
            await state.api.update_call(state.call_id, case_id=case["id"])

        others = case["report_count"] - 1
        corroboration = f", reported by {others} other resident(s)" if others > 0 else ""
        found = (
            f"Found {case['case_number']}: {case.get('issue_type') or 'unclassified'} at "
            f"{case.get('location') or 'an unrecorded location'}, status {case['status']}, "
            f"priority {case['priority']}, with {case['department'].replace('_', ' ')}"
            f"{corroboration}. Opened {case['created_at'][:10]}."
        )

        on_file = state.on_file or {}
        last4, name = on_file.get("phone_last4"), on_file.get("name")
        if not last4 and not name:
            return (
                f"{found} Nobody left contact details on this case, so there is nothing "
                f"to verify against. Give the status, then offer to add the caller as a "
                f"reporter: take their name and callback number and call "
                f"add_reporter_to_case."
            )
        if not last4:
            return (
                f"{found} The reporter on file is {name}, with no number on file. Give "
                f"the status, then ask whether you are speaking with {name}. Whatever "
                f"they say, call confirm_caller_identity."
            )
        return (
            f"{found} Now verify the caller before treating them as the reporter. Ask "
            f"exactly this shape of question: \"does your callback number end in "
            f"{last4}?\". Those four digits are the only part of the number you have, "
            f"and the only part you may say. If they confirm, ask whether you are "
            f"speaking with {name or 'the name on file'} - not before. Then call "
            f"confirm_caller_identity with the answer."
        )

    @function_tool
    async def confirm_caller_identity(
        self, ctx: RunContext[CallState], is_reporter_on_file: bool
    ) -> str:
        """Record whether the caller turned out to be the reporter on file.

        Call this after you have asked about the last four digits and, if those
        matched, about the name. Answer honestly: a caller who hesitated, gave
        different digits, or gave a different name is not that person, and
        saying they are hands one resident another resident's case.

        Args:
            is_reporter_on_file: True only when the caller confirmed BOTH the
                last four digits and the name on file. False for anything else,
                including a caller who declined to answer.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Look a case up first."

        state.identity_verified = is_reporter_on_file
        if not is_reporter_on_file:
            return (
                f"Not the reporter on file. They are a new reporter on {state.case_number}, "
                f"which is a normal thing to be - a second resident about the same problem. "
                f"Do not repeat anything on file back to them. Take their own name and "
                f"callback number and call add_reporter_to_case."
            )

        name = (state.on_file or {}).get("name")
        if name:
            await state.set_caller_name(name)
        return (
            f"Verified as the reporter on {state.case_number}. You may discuss their case "
            f"and add anything new with add_case_note."
        )

    @function_tool
    async def add_reporter_to_case(
        self,
        ctx: RunContext[CallState],
        caller_name: str,
        phone: str,
        description: str | None = None,
    ) -> str:
        """File this caller's own report against the case they asked about.

        For a caller who is not the reporter on file. The city tracks one case
        per problem and one report per resident, so this adds their account to
        the incident rather than opening a duplicate: the case gains
        corroboration and the city gets a way to call this caller back.

        Args:
            caller_name: This caller's own full name, as they said it.
            phone: This caller's own callback number, digits only.
            description: What they are seeing now, in their words, if it adds
                anything to what the case already says.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Look a case up first, or take a new report with file_report."

        digits = "".join(ch for ch in phone if ch.isdigit())
        result = await state.api.file_report(
            case_id=state.case_id,
            reporter_name=caller_name,
            reporter_phone=digits,
            description=description,
            call_id=state.call_id,
        )
        case, report = result["case"], result["report"]
        state.report_id = report["id"]
        await state.set_caller_name(caller_name)
        if state.call_id is not None:
            await state.api.update_call(state.call_id, report_id=report["id"])

        logger.info("added reporter %s to case %s", report["id"], state.case_number)
        return (
            f"Added them as a reporter on {case['case_number']}, which now has "
            f"{case['report_count']} reports. Tell the caller the city already knows about "
            f"this one, that their report is now on it, and give them that case number."
        )

    @function_tool
    async def add_case_note(self, ctx: RunContext[CallState], note: str) -> str:
        """Append a note to the open case, for anything that is not a stored field.

        Args:
            note: What the caller told you, in one sentence.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Nothing is open yet."
        await state.api.add_note(state.case_id, note)
        return "Note added."

    @function_tool
    async def escalate_to_human(self, ctx: RunContext[CallState], reason: str) -> str:
        """Flag the case for immediate human review. Use for danger to people.

        Args:
            reason: One line on why a person needs to see this now.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "File the report first, then escalate it."
        case = await state.api.escalate(state.case_id, reason)
        logger.warning("escalated %s: %s", state.case_number, reason)
        return (
            f"Case {case['case_number']} is flagged for human review and is now at the top "
            f"of the queue. Tell the caller a person is being brought in, and to call 911 "
            f"if anyone is in immediate danger."
        )

    @function_tool
    async def end_call(self, ctx: RunContext[CallState]) -> str:
        """Hang up. Call this once the caller has confirmed they have nothing further.

        Two conditions, both required. The caller has told you they have
        nothing more to add, and you have already delivered your closing line.
        Never call this before both are true, and never while you are still
        waiting on something you asked for - a phone number, a spelling, a
        confirmation. A caller cut off mid-answer has to ring back and start
        again. If you are unsure whether they are finished, ask.
        """
        state = ctx.userdata
        if state.request_hangup is None:
            return "This call cannot be ended from here."
        state.request_hangup()
        logger.info("hanging up call %s", state.call_id)
        return "The line will close once you have finished speaking. Say nothing further."

    @function_tool
    async def set_call_phase(
        self,
        ctx: RunContext[CallState],
        phase: Literal["greeting", "gathering", "filed", "wrapping", "ended"],
        activity: str | None = None,
    ) -> str:
        """Tell the staff dashboard where this conversation has got to.

        Staff watch live calls progress. Call this when the conversation moves
        on, not on every turn.

        Args:
            phase: Use gathering once you are collecting details, and wrapping
                when you start reading the case number back. filed and ended are
                set for you when you file a report and when the call hangs up.
            activity: One short present-tense sentence, under about sixty
                characters, saying what you are doing right now, such as
                "Handling request about pothole on Oak Street." This is what a
                supervisor reads on the live console beside the phase.
        """
        state = ctx.userdata
        await state.set_phase(phase, activity)
        return f"Phase is {phase}."

    @function_tool
    async def set_sentiment(
        self,
        ctx: RunContext[CallState],
        sentiment: Literal["positive", "neutral", "negative"],
    ) -> str:
        """Record how the caller sounds, whenever their tone clearly shifts.

        Your own read is the signal here, so do not overthink it. Use negative
        for a caller who is frustrated, angry, or distressed, positive once
        somebody who was unhappy has been reassured, and neutral otherwise. A
        supervisor watching the live console uses this to decide which call to
        step into, so it is only useful while the call is still up.

        Args:
            sentiment: How the caller sounds right now.
        """
        state = ctx.userdata
        await state.set_sentiment(sentiment)
        return f"Sentiment is {sentiment}."

    @function_tool
    async def set_status(
        self,
        ctx: RunContext[CallState],
        status: Literal["new", "in_progress", "needs_info", "resolved"],
    ) -> str:
        """Change the status of the open case.

        Use needs_info when the caller could not supply something a crew will
        need, such as a location.

        Args:
            status: The new status.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Nothing is open yet."
        await state.api.update_case(state.case_id, status=status)
        # Remembered so the hangup does not park a case the agent resolved.
        state.status_set = True
        return f"Status set to {status}."


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    api = CaseAPI()
    state = CallState(api=api)

    call = await api.start_call(ctx.room.name)
    state.call_id = call["id"]
    logger.info("call %s started in room %s", state.call_id, ctx.room.name)

    pending: set[asyncio.Task] = set()
    session = AgentSession[CallState](
        userdata=state,
        llm=openai.realtime.RealtimeModel(
            voice="marin",
            input_audio_transcription=TRANSCRIPTION,
        ),
    )

    def _spawn(coro) -> None:
        """Fire and forget, holding a reference so the task is not collected."""
        task = asyncio.create_task(coro)
        pending.add(task)
        task.add_done_callback(pending.discard)

    @session.on("user_input_transcribed")
    def _on_transcript(ev: UserInputTranscribedEvent) -> None:
        """Stream the caller's words as they arrive, before the sentence is done.

        livekit-agents 1.7 emits this repeatedly with a growing transcript and
        ``is_final`` false. The finals are ignored here: they arrive again as a
        conversation item, and that is the one path that writes to the database.
        """
        if ev.is_final or state.call_id is None:
            return
        text = (ev.transcript or "").strip()
        if text:
            _spawn(api.add_interim(state.call_id, "caller", text))

    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        """Mirror each finished utterance into the case timeline."""
        item = ev.item
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            return
        text = getattr(item, "text_content", None) or ""
        if not text.strip() or state.call_id is None:
            return
        speaker = "caller" if role == "user" else "agent"

        async def _write(call_id: int, speaker: str, text: str) -> None:
            # The agent side has no interim event in livekit-agents 1.7, so its
            # utterance gets one delta of its own before the final turn. The
            # dashboard then renders both speakers the same way.
            if speaker == "agent":
                await api.add_interim(call_id, speaker, text)
            await api.add_turn(call_id, speaker, text)

        _spawn(_write(state.call_id, speaker, text.strip()))

    async def _hangup() -> None:
        """Let the goodbye finish playing, then tear the room down.

        Drain first. ``end_call`` returns before the closing line has finished
        playing, and deleting the room out from under it cuts the caller off
        mid-sentence. Deleting the room is also what triggers the shutdown
        callback below, so the summary, the completed status, and the ended
        phase all still land.
        """
        await session.drain()
        await ctx.delete_room()

    state.request_hangup = lambda: _spawn(_hangup())

    async def _finish() -> None:
        """On hangup: write a summary, close the call, and park the case unless
        the agent already ruled on it."""
        try:
            if state.call_id is None:
                return
            await state.set_phase("wrapping", "Closing out the call and writing a summary.")
            summary = await _summarize(session)
            # status=completed also moves the phase to ended, in the backend, so
            # a crash between these two calls cannot leave a call looking live.
            await api.update_call(state.call_id, status="completed", summary=summary)
            if state.case_id is not None:
                # The summary always lands. The status only does when the agent
                # never ruled on this case: parking a fresh intake with the
                # department is right, overwriting a deliberate ``resolved`` or
                # ``needs_info`` at hangup is not.
                await api.update_case(
                    state.case_id,
                    summary=summary,
                    status=None if state.status_set else "in_progress",
                )
        except Exception:
            logger.exception("failed to close out call")
        finally:
            await api.aclose()

    ctx.add_shutdown_callback(_finish)

    await session.start(agent=IntakeAgent(), room=ctx.room)

    # Speak first. A 311 line that waits for the caller to talk sounds broken,
    # and the caller has no way to know the agent picked up.
    session.generate_reply(instructions=f"Greet the caller with exactly: {GREETING}")


async def _summarize(session: AgentSession) -> str:
    """One short paragraph a staff member can read instead of the transcript."""
    lines = []
    for item in session.history.items:
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            continue
        text = (getattr(item, "text_content", None) or "").strip()
        if text:
            lines.append(f"{'Caller' if role == 'user' else 'Agent'}: {text}")

    if not lines:
        return "Call ended before anything was said."

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": (
                    "Summarize this 311 intake call for the city staffer who will work "
                    "the case. Three sentences at most: what was reported, where, and "
                    "anything still missing. No preamble."
                ),
            },
            {"role": "user", "content": "\n".join(lines)},
        ],
    )
    return (response.choices[0].message.content or "").strip()


if __name__ == "__main__":
    cli.run_app(server)
