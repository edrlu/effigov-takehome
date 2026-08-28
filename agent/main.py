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

Your job is one of two things:

1. Taking a new service request. As soon as you understand roughly what the
   problem is, call `open_request` right away - do not wait until you have
   every detail. Then keep the conversation going and call `update_request`
   each time you learn something new: the caller's name, their callback number,
   the address of the problem, or a better description. Read the case number
   back to the caller once, near the end, digit by digit.

2. Checking on an existing request. Ask for the case number or the phone number
   they used, call `look_up_request`, then tell them the status in one sentence.
   If they add new information, call `add_case_note`.

Rules:
- Confirm phone numbers and addresses by repeating them back before you save.
- If the caller reports an active hazard such as a gas smell, flooding, or a
  downed line, set priority to high and tell them to hang up and call 911 if
  anyone is in danger.
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
    collected: dict[str, str] = field(default_factory=dict)


class IntakeAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    # -- tools ------------------------------------------------------------

    @function_tool
    async def open_request(
        self,
        ctx: RunContext[CallState],
        issue_type: IssueType,
        description: str,
    ) -> str:
        """Open a new service request as soon as the problem is understood.

        Call this early, with whatever you have. Details are filled in later
        with update_request.

        Args:
            issue_type: Best guess at the category of the problem.
            description: One or two sentences in the caller's own words.
        """
        state = ctx.userdata
        if state.case_id is not None:
            return f"A request is already open on this call: {state.case_number}."

        case = await state.api.create_case(issue_type=issue_type, description=description)
        state.case_id = case["id"]
        state.case_number = case["case_number"]

        if state.call_id is not None:
            await state.api.update_call(state.call_id, case_id=case["id"])

        logger.info("opened case %s", state.case_number)
        return (
            f"Opened case {state.case_number}. Now collect the caller's name, callback "
            f"number, and the address of the problem, and save each one with update_request."
        )

    @function_tool
    async def update_request(
        self,
        ctx: RunContext[CallState],
        caller_name: str | None = None,
        phone: str | None = None,
        address: str | None = None,
        description: str | None = None,
        issue_type: IssueType | None = None,
        priority: Literal["low", "normal", "high"] | None = None,
    ) -> str:
        """Save newly learned details onto the open request. Call this often.

        Args:
            caller_name: Caller's full name, as they said it.
            phone: Callback number, digits only.
            address: Street address of the problem, not the caller's home unless they match.
            description: An improved description of the problem.
            issue_type: A corrected category, if the first guess was wrong.
            priority: Raise to high only for an active hazard.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "No request is open yet. Call open_request first."

        if phone:
            phone = "".join(ch for ch in phone if ch.isdigit())

        await state.api.update_case(
            state.case_id,
            caller_name=caller_name,
            phone=phone,
            address=address,
            description=description,
            issue_type=issue_type,
            priority=priority,
        )
        changed = {
            "caller_name": caller_name,
            "phone": phone,
            "address": address,
            "description": description,
            "issue_type": issue_type,
            "priority": priority,
        }
        state.collected.update({k: v for k, v in changed.items() if v})
        logger.info("updated case %s: %s", state.case_number, sorted(state.collected))
        return f"Saved. Case {state.case_number} is up to date."

    @function_tool
    async def look_up_request(self, ctx: RunContext[CallState], identifier: str) -> str:
        """Find an existing request by case number or by the caller's phone number.

        Args:
            identifier: A case number like SR-123456, or a ten digit phone number.
        """
        state = ctx.userdata
        case = await state.api.lookup_case(identifier)
        if case is None:
            return "No request found for that. Offer to open a new one."

        state.case_id = case["id"]
        state.case_number = case["case_number"]
        if state.call_id is not None:
            await state.api.update_call(state.call_id, case_id=case["id"])

        return (
            f"Found {case['case_number']}: {case.get('issue_type') or 'unclassified'}, "
            f"status {case['status']}, opened {case['created_at'][:10]}, "
            f"reported as: {case.get('description') or 'no description'}."
        )

    @function_tool
    async def add_case_note(self, ctx: RunContext[CallState], note: str) -> str:
        """Append a note to the open request, for anything that is not a stored field.

        Args:
            note: What the caller told you, in one sentence.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "No request is open yet."
        await state.api.add_note(state.case_id, note)
        return "Note added."

    @function_tool
    async def set_status(
        self,
        ctx: RunContext[CallState],
        status: Literal["new", "in_progress", "needs_info", "resolved"],
    ) -> str:
        """Change the status of the open request.

        Use needs_info when the caller could not supply something a crew will
        need, such as an address.

        Args:
            status: The new status.
        """
        state = ctx.userdata
        if state.case_id is None:
            return "No request is open yet."
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
