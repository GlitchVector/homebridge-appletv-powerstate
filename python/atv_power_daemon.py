#!/usr/bin/env python3
"""
Long-lived pyatv daemon that keeps a Companion-protocol session open to an
Apple TV and emits power-state changes as newline-delimited JSON on stdout.

Each event line is one JSON object, e.g.:
    {"state": "on",  "reason": "initial"}
    {"state": "off", "reason": "push"}
    {"error": "connection_lost: ...", "reason": "connection_lost"}

The Node plugin side spawns this once per device and tails stdout; there is
no per-poll process fork and no per-poll TLS handshake.
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
    def __init__(self, daemon: "Daemon") -> None:
        self._daemon = daemon

    def powerstate_update(self, old_state: PowerState, new_state: PowerState) -> None:
        emit({"state": state_label(new_state), "reason": "push"})


class _DevicePushListener(DeviceListener):
    def __init__(self, daemon: "Daemon") -> None:
        self._daemon = daemon

    def connection_lost(self, exception: Optional[Exception]) -> None:
        emit({"error": f"connection_lost: {exception}", "reason": "connection_lost"})
        self._daemon.schedule_reconnect()

    def connection_closed(self) -> None:
        emit({"error": "connection_closed", "reason": "connection_closed"})
        self._daemon.schedule_reconnect()


class Daemon:
    def __init__(
        self,
        ip: str,
        companion_credentials: Optional[str],
        heartbeat_seconds: float,
    ) -> None:
        self._ip = ip
        self._companion_credentials = companion_credentials
        self._heartbeat_seconds = heartbeat_seconds
        self._atv: Optional[AppleTV] = None
        self._reconnect_event = asyncio.Event()
        self._backoff = 1.0

    def schedule_reconnect(self) -> None:
        self._reconnect_event.set()

    async def _connect_once(self) -> None:
        loop = asyncio.get_running_loop()
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
        atv.listener = _DevicePushListener(self)
        atv.power.listener = _PowerPushListener(self)
        self._atv = atv
        self._backoff = 1.0

        emit({"state": state_label(atv.power.power_state), "reason": "initial"})

    async def _heartbeat(self) -> None:
        # Re-emits current state periodically so the Node side can verify the
        # session is alive. Cost is near zero: pyatv keeps state cached from
        # the push channel, this is just a property read on a live connection.
        while not self._reconnect_event.is_set():
            await asyncio.sleep(self._heartbeat_seconds)
            if self._atv is None or self._reconnect_event.is_set():
                return
            try:
                emit({
                    "state": state_label(self._atv.power.power_state),
                    "reason": "heartbeat",
                })
            except Exception as exc:  # noqa: BLE001 - intentionally broad
                emit({"error": f"heartbeat failed: {exc}", "reason": "heartbeat_error"})
                self.schedule_reconnect()
                return

    async def run(self) -> None:
        while True:
            try:
                await self._connect_once()
                self._reconnect_event.clear()
                await self._heartbeat()
                await self._reconnect_event.wait()
            except Exception as exc:  # noqa: BLE001
                emit({"error": f"connect failed: {exc}", "reason": "connect_error"})
            finally:
                if self._atv is not None:
                    try:
                        self._atv.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._atv = None

            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, 60.0)


async def amain(args: argparse.Namespace) -> None:
    daemon = Daemon(
        ip=args.ip,
        companion_credentials=args.companion_credentials,
        heartbeat_seconds=args.heartbeat_seconds,
    )

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            # not supported on some platforms, ignore
            pass

    run_task = asyncio.create_task(daemon.run())
    stop_task = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait(
        {run_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()


def main() -> int:
    parser = argparse.ArgumentParser(description="pyatv long-lived power-state daemon")
    parser.add_argument("--ip", required=True, help="Apple TV IP address")
    parser.add_argument(
        "--companion-credentials",
        default=None,
        help="Companion-protocol credentials string from pyatv pairing",
    )
    parser.add_argument(
        "--heartbeat-seconds",
        type=float,
        default=30.0,
        help="Interval for heartbeat state re-emit (safety net; cheap, 0 network)",
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
