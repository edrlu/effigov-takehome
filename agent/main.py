"""LiveKit voice agent: the 311 intake line for the City of Bayview.

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
"""

from __future__ import annotations

import asyncio
import logging
import os
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
    cli,
    function_tool,
)
from livekit.plugins import openai

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

INSTRUCTIONS = """
You are Ava, the automated intake line for the City of Bayview's 311 service
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
   they used, call `look_up_request`, then give the status in one sentence. If
   they add new information, call `add_case_note`.

Rules:
- Confirm phone numbers and locations by repeating them back before you save.
- If the caller describes an immediate danger to people, such as a sparking or
  downed power line, a gas smell, active flooding, or a blocked fire exit, call
  `escalate_to_human` right away with a one line reason, tell the caller a
  person is being brought in, and tell them to call 911 if anyone is in danger.
- Never invent a case number, a status, or a repair timeline. If you do not
  know, say you do not know.
- Open with: "Bayview 311, this is Ava. How can I help you today?"
"""


@dataclass
class CallState:
    """Everything the agent needs to remember for the duration of one call."""

    api: CaseAPI
    call_id: int | None = None
    case_id: int | None = None
    case_number: str | None = None
    report_id: int | None = None
    collected: dict[str, str] = field(default_factory=dict)


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
        """
        state = ctx.userdata
        if state.case_id is not None:
            return f"A report is already open on this call: {state.case_number}."

        result = await state.api.file_report(
            issue_type=issue_type,
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

        logger.info(
            "filed report %s on case %s (merged=%s)",
            report["id"],
            state.case_number,
            result["merged"],
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
        description: str | None = None,
        issue_type: IssueType | None = None,
    ) -> str:
        """Save newly learned details. Call this every time the caller tells you something.

        Args:
            caller_name: Caller's full name, as they said it.
            phone: Callback number, digits only.
            location: A corrected or more precise location for the problem.
            description: An improved description of the problem.
            issue_type: A corrected category, if the first guess was wrong.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "Nothing is open yet. Call file_report first."

        if phone:
            phone = "".join(ch for ch in phone if ch.isdigit())

        if state.report_id is not None and (caller_name or phone or description):
            await state.api.update_report(
                state.report_id,
                reporter_name=caller_name,
                reporter_phone=phone,
                description=description,
            )

        if location or description or issue_type:
            await state.api.update_case(
                state.case_id,
                location=location,
                description=description,
                issue_type=issue_type,
            )

        saved = {
            "caller_name": caller_name,
            "phone": phone,
            "location": location,
            "description": description,
            "issue_type": issue_type,
        }
        state.collected.update({k: v for k, v in saved.items() if v})
        logger.info("updated %s: %s", state.case_number, sorted(state.collected))
        return f"Saved. Case {state.case_number} is up to date."

    @function_tool
    async def look_up_request(self, ctx: RunContext[CallState], identifier: str) -> str:
        """Find an existing case by case number or by the caller's phone number.

        Args:
            identifier: A case number like SR-123456, or a ten digit phone number.
        """
        state = ctx.userdata
        case = await state.api.lookup_case(identifier)
        if case is None:
            return "No case found for that. Offer to take a new report."

        state.case_id = case["id"]
        state.case_number = case["case_number"]
        if state.call_id is not None:
            await state.api.update_call(state.call_id, case_id=case["id"])

        others = case["report_count"] - 1
        corroboration = f", reported by {others} other resident(s)" if others > 0 else ""
        return (
            f"Found {case['case_number']}: {case.get('issue_type') or 'unclassified'} at "
            f"{case.get('location') or 'an unrecorded location'}, status {case['status']}, "
            f"priority {case['priority']}, with {case['department'].replace('_', ' ')}"
            f"{corroboration}. Opened {case['created_at'][:10]}."
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
        llm=openai.realtime.RealtimeModel(voice="marin"),
    )

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
        # Fire and forget, but hold a reference so the task is not garbage collected.
        task = asyncio.create_task(api.add_turn(state.call_id, speaker, text.strip()))
        pending.add(task)
        task.add_done_callback(pending.discard)

    async def _finish() -> None:
        """On hangup: write a summary, close the call, park the case for staff."""
        try:
            if state.call_id is None:
                return
            summary = await _summarize(session)
            await api.update_call(state.call_id, status="completed", summary=summary)
            if state.case_id is not None:
                await api.update_case(state.case_id, summary=summary, status="in_progress")
        except Exception:
            logger.exception("failed to close out call")
        finally:
            await api.aclose()

    ctx.add_shutdown_callback(_finish)

    await session.start(agent=IntakeAgent(), room=ctx.room)


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
