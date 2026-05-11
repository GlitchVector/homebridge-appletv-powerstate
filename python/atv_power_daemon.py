#!/usr/bin/env python3
"""
pyatv Apple TV power-state daemon.

Emits newline-delimited JSON events on stdout:
    {"state": "on"|"off", "reason": "initial"|"push"|"refresh"}
    {"error": "...", "reason": "..."}

On tvOS 15+ with Companion-only pairing, pyatv's cached ``power.power_state``
is populated at connect time and is not refreshed reliably — the push
listener fires only on some transitions. A long-running connection ends up
reporting the initial state forever. To guarantee freshness we force a
reconnect on every refresh cycle: a fresh connection always reads the
current state correctly. The push listener stays installed so transitions
that *do* emit push are still caught instantly.

The daemon is one long-lived Python process (no per-poll fork, no pyatv
import overhead between cycles), so this is much cheaper than the original
"spawn-per-poll" approach even though connections are short.
"""

import argparse
import asyncio
import json
import logging
import signal
import sys
from typing import Optional

import pyatv
from pyatv.const import PowerState, Protocol
from pyatv.interface import AppleTV, DeviceListener, PowerListener


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def state_label(state: PowerState) -> str:
    if state == PowerState.On:
        return "on"
    if state == PowerState.Off:
        return "off"
    return "unknown"


class _PowerPushListener(PowerListener):
    def powerstate_update(self, old_state: PowerState, new_state: PowerState) -> None:
        emit({"state": state_label(new_state), "reason": "push"})


class _DeviceNoopListener(DeviceListener):
    # Required interface; we recover via the refresh loop rather than callbacks.
    def connection_lost(self, exception: Optional[Exception]) -> None:
        emit({"error": f"connection_lost: {exception}", "reason": "connection_lost"})

    def connection_closed(self) -> None:
        pass


class Daemon:
    def __init__(
        self,
        ip: str,
        companion_credentials: Optional[str],
        refresh_seconds: float,
        identifier: Optional[str] = None,
        companion_port: int = 49153,
    ) -> None:
        self._ip = ip
        self._companion_credentials = companion_credentials
        self._refresh_seconds = refresh_seconds
        self._identifier = identifier
        self._companion_port = companion_port
        self._atv: Optional[AppleTV] = None
        self._stop_event = asyncio.Event()

    def request_stop(self) -> None:
        self._stop_event.set()

    async def _connect(self, reason: str) -> None:
        loop = asyncio.get_running_loop()

        if self._identifier and self._companion_credentials:
            # Fast path: skip mDNS scan when identifier+credentials are known.
            # mDNS multicast does not cross VLAN boundaries; without this,
            # Homebridge running on a different VLAN than the Apple TV cannot
            # discover it. With identifier+credentials we can build the config
            # ourselves and connect directly via Companion (port 49153 default).
            import ipaddress
            from pyatv import conf as _conf
            config = _conf.AppleTV(
                address=ipaddress.IPv4Address(self._ip),
                name="AppleTV",
            )
            service = _conf.ManualService(
                identifier=self._identifier,
                protocol=Protocol.Companion,
                port=self._companion_port,
                properties={},
                credentials=self._companion_credentials,
            )
            config.add_service(service)
            conf = config
        else:
            confs = await pyatv.scan(loop, hosts=[self._ip], timeout=5.0)
            if not confs:
                raise RuntimeError(f"no Apple TV found at {self._ip}")
            conf = confs[0]
            if self._companion_credentials:
                service = conf.get_service(Protocol.Companion)
                if service is None:
                    raise RuntimeError("Apple TV advertises no Companion service")
                service.credentials = self._companion_credentials

        atv = await pyatv.connect(conf, loop)
        atv.listener = _DeviceNoopListener()
        atv.power.listener = _PowerPushListener()
        self._atv = atv

        emit({"state": state_label(atv.power.power_state), "reason": reason})

    async def _close(self) -> None:
        atv = self._atv
        self._atv = None
        if atv is not None:
            try:
                atv.close()
            except Exception:  # noqa: BLE001
                pass

    async def _wait(self, seconds: float) -> bool:
        """Sleep up to `seconds` or until stop. Returns True if stop was requested."""
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)
            return True
        except asyncio.TimeoutError:
            return False

    async def run(self) -> None:
        first = True
        backoff = 1.0
        try:
            while not self._stop_event.is_set():
                try:
                    await self._connect("initial" if first else "refresh")
                except Exception as exc:  # noqa: BLE001
                    emit({"error": f"connect failed: {exc}", "reason": "connect_error"})
                    await self._close()
                    if await self._wait(backoff):
                        return
                    backoff = min(backoff * 2, 60.0)
                    continue

                first = False
                backoff = 1.0

                if await self._wait(self._refresh_seconds):
                    return
                await self._close()
        finally:
            await self._close()


async def amain(args: argparse.Namespace) -> None:
    daemon = Daemon(
        ip=args.ip,
        companion_credentials=args.companion_credentials,
        refresh_seconds=args.refresh_seconds,
        identifier=args.identifier,
        companion_port=args.companion_port,
    )

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, daemon.request_stop)
        except NotImplementedError:
            pass

    await daemon.run()


def main() -> int:
    parser = argparse.ArgumentParser(description="pyatv Apple TV power-state daemon")
    parser.add_argument("--ip", required=True, help="Apple TV IP address")
    parser.add_argument(
        "--companion-credentials",
        default=None,
        help="Companion-protocol credentials string from pyatv pairing",
    )
    parser.add_argument(
        "--identifier",
        default=None,
        help="Apple TV identifier (skips mDNS scan when provided with --companion-credentials)",
    )
    parser.add_argument(
        "--companion-port",
        type=int,
        default=49153,
        help="Companion-protocol TCP port (default 49153; only used in scan-skip fast path)",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=float,
        default=2.0,
        help="Interval between forced reconnects that re-read live power state",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
