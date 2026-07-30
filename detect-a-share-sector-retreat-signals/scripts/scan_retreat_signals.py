#!/usr/bin/env python3
"""Scan A-share daily bars for retreat signals using turnover amount."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

try:
    import baostock as bs
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: baostock. Install it in a temporary virtual environment: "
        "python3 -m venv /tmp/retreat-signal-venv && "
        "/tmp/retreat-signal-venv/bin/pip install baostock"
    ) from exc


@dataclass
class Bar:
    day: str
    close: float
    preclose: float
    amount: float

    @property
    def ret(self) -> float:
        return self.close / self.preclose - 1


ROLE_WEIGHTS = {
    "weight": {
        "two_day_high_amount_collapse": 0.85,
        "three_day_high_amount_retreat": 1.00,
        "two_day_severe_acceptance_collapse": 0.45,
        "two_day_acceptance_collapse": 0.45,
        "holding_inertia_or_acceptance_decay": 0.20,
        "unclassified_price_collapse": 0.10,
    },
    "emotion": {
        "two_day_high_amount_collapse": 1.00,
        "three_day_high_amount_retreat": 0.90,
        "two_day_severe_acceptance_collapse": 1.00,
        "two_day_acceptance_collapse": 0.80,
        "holding_inertia_or_acceptance_decay": 0.35,
        "unclassified_price_collapse": 0.20,
    },
    "dual": {
        "two_day_high_amount_collapse": 1.00,
        "three_day_high_amount_retreat": 1.00,
        "two_day_severe_acceptance_collapse": 1.00,
        "two_day_acceptance_collapse": 0.75,
        "holding_inertia_or_acceptance_decay": 0.30,
        "unclassified_price_collapse": 0.15,
    },
}

DEFAULT_CLASSIFICATION_CONFIG = (
    Path(__file__).resolve().parents[1] / "config" / "stock_roles.json"
)


def mean(values: Iterable[float]) -> float | None:
    data = list(values)
    return sum(data) / len(data) if data else None


def fetch_bars(code: str, start: str, end: str) -> list[Bar]:
    result = bs.query_history_k_data_plus(
        code,
        "date,close,preclose,amount,tradestatus",
        start_date=start,
        end_date=end,
        frequency="d",
        adjustflag="2",
    )
    if result.error_code != "0":
        raise RuntimeError(f"{code}: {result.error_msg}")

    bars: list[Bar] = []
    while result.next():
        day, close, preclose, amount, status = result.get_row_data()
        if status != "1" or not close or not preclose or not amount:
            continue
        bars.append(Bar(day, float(close), float(preclose), float(amount)))
    return bars


def prior_means(bars: list[Bar], index: int) -> dict[str, float | None]:
    prior20 = bars[max(0, index - 20) : index]
    prior60 = bars[max(0, index - 60) : index]
    return {
        "all20": mean(bar.amount for bar in prior20),
        "up20": mean(bar.amount for bar in prior20 if bar.ret > 0),
        "up60": mean(bar.amount for bar in prior60 if bar.ret > 0),
    }


def event_payload(
    name: str,
    code: str,
    signal: str,
    window: list[Bar],
    next_day: str | None,
    baselines: dict[str, float | None],
) -> dict:
    start_preclose = window[0].preclose
    up20 = baselines["up20"]
    all20 = baselines["all20"]
    up60 = baselines["up60"]

    def ratio(value: float, baseline: float | None) -> float | None:
        return round(value / baseline, 4) if baseline else None

    return {
        "name": name,
        "code": code,
        "signal": signal,
        "start_date": window[0].day,
        "confirm_date": window[-1].day,
        "next_trading_day": next_day,
        "daily_returns_pct": [round(bar.ret * 100, 4) for bar in window],
        "cumulative_return_pct": round(
            (window[-1].close / start_preclose - 1) * 100, 4
        ),
        "amount_100m_cny": [round(bar.amount / 100_000_000, 4) for bar in window],
        "amount_vs_up20": [ratio(bar.amount, up20) for bar in window],
        "amount_vs_all20": [ratio(bar.amount, all20) for bar in window],
        "amount_vs_up60": [ratio(bar.amount, up60) for bar in window],
        "baseline_drift_up20_vs_up60": (
            round(up20 / up60 - 1, 4) if up20 and up60 else None
        ),
    }


def scan_stock(
    name: str, code: str, role: str | None, bars: list[Bar], year: int
) -> list[dict]:
    events: list[dict] = []
    for index in range(60, len(bars)):
        first = bars[index]
        if int(first.day[:4]) != year or first.ret > -0.05:
            continue

        baselines = prior_means(bars, index)
        up20 = baselines["up20"]
        all20 = baselines["all20"]
        if not up20 or not all20:
            continue

        if index + 1 < len(bars):
            two = bars[index : index + 2]
            cumulative = two[-1].close / two[0].preclose - 1
            if all(bar.ret < 0 for bar in two) and cumulative <= -0.10:
                if all(bar.amount >= up20 for bar in two):
                    events.append(
                        event_payload(
                            name,
                            code,
                            "two_day_high_amount_collapse",
                            two,
                            bars[index + 2].day if index + 2 < len(bars) else None,
                            baselines,
                        )
                    )
                elif (
                    (
                        two[0].amount < up20
                        and two[1].amount <= 0.70 * up20
                        and two[1].amount <= 0.80 * two[0].amount
                    )
                    or (
                        two[0].amount <= 0.70 * up20
                        and two[1].amount <= 0.70 * up20
                        and two[1].amount <= two[0].amount
                    )
                ):
                    events.append(
                        event_payload(
                            name,
                            code,
                            "two_day_severe_acceptance_collapse",
                            two,
                            bars[index + 2].day if index + 2 < len(bars) else None,
                            baselines,
                        )
                    )
                elif two[1].amount < up20 and two[1].amount < two[0].amount:
                    events.append(
                        event_payload(
                            name,
                            code,
                            "two_day_acceptance_collapse",
                            two,
                            bars[index + 2].day if index + 2 < len(bars) else None,
                            baselines,
                        )
                    )
                else:
                    events.append(
                        event_payload(
                            name,
                            code,
                            "unclassified_price_collapse",
                            two,
                            bars[index + 2].day if index + 2 < len(bars) else None,
                            baselines,
                        )
                    )

        if index + 2 < len(bars):
            three = bars[index : index + 3]
            if all(bar.ret < 0 for bar in three) and all(
                bar.amount >= up20 for bar in three
            ):
                events.append(
                    event_payload(
                        name,
                        code,
                        "three_day_high_amount_retreat",
                        three,
                        bars[index + 3].day if index + 3 < len(bars) else None,
                        baselines,
                    )
                )

        end = index
        while end + 1 < len(bars) and bars[end + 1].ret < 0:
            end += 1
        if end >= index + 1:
            for confirm in range(index, end + 1):
                cumulative = bars[confirm].close / bars[index].preclose - 1
                if (
                    confirm >= index + 1
                    and bars[confirm].amount < all20
                    and cumulative <= -0.10
                ):
                    events.append(
                        event_payload(
                            name,
                            code,
                            "holding_inertia_or_acceptance_decay",
                            bars[index : confirm + 1],
                            (
                                bars[confirm + 1].day
                                if confirm + 1 < len(bars)
                                else None
                            ),
                            baselines,
                        )
                    )
                    break

    for event in events:
        weight = ROLE_WEIGHTS.get(role or "", {}).get(event["signal"])
        event["company_role"] = role
        event["decision_weight"] = weight
        event["decision_level"] = (
            "primary_retreat"
            if weight is not None and weight == 1.00
            else "secondary_warning"
            if weight is not None and weight >= 0.70
            else "state_confirmation"
            if weight is not None and weight < 0.70
            else "unclassified_role"
        )

    events.sort(key=lambda item: (item["confirm_date"], item["signal"]))
    return events


def load_classification_config(path: str | None) -> dict[str, dict]:
    config_path = Path(path) if path else DEFAULT_CLASSIFICATION_CONFIG
    if not config_path.exists():
        return {}
    with config_path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    stocks = payload.get("stocks")
    if not isinstance(stocks, dict):
        raise ValueError(f"{config_path}: stocks must be an object keyed by stock code")
    for code, record in stocks.items():
        if not isinstance(record, dict) or record.get("role") not in ROLE_WEIGHTS:
            raise ValueError(
                f"{config_path}: {code} must declare role as weight, emotion, or dual"
            )
    return stocks


def parse_stock(value: str) -> tuple[str, str, str | None]:
    parts = value.split("=")
    if len(parts) not in (2, 3):
        raise argparse.ArgumentTypeError(
            "Use NAME=sh.600000=weight, NAME=sz.000001=emotion, or omit role"
        )
    name, code = parts[:2]
    role = parts[2] if len(parts) == 3 else None
    if not name or not (code.startswith("sh.") or code.startswith("sz.")):
        raise argparse.ArgumentTypeError("Use NAME=sh.600000 or NAME=sz.000001")
    if role not in (None, "weight", "emotion", "dual"):
        raise argparse.ArgumentTypeError("Role must be weight, emotion, or dual")
    return name, code, role


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stocks", nargs="+", required=True, type=parse_stock)
    parser.add_argument("--start", default="2025-08-01")
    parser.add_argument("--end", default=date.today().isoformat())
    parser.add_argument("--year", type=int)
    parser.add_argument(
        "--classification-config",
        help=(
            "JSON stock-role config. Defaults to config/stock_roles.json inside the skill. "
            "An explicit role in --stocks overrides the config."
        ),
    )
    parser.add_argument("--output")
    args = parser.parse_args()
    year = args.year or int(args.end[:4])
    classifications = load_classification_config(args.classification_config)

    login = bs.login()
    if login.error_code != "0":
        raise SystemExit(f"BaoStock login failed: {login.error_msg}")
    try:
        result = {
            "source": "BaoStock daily k data",
            "adjustflag": "2",
            "start": args.start,
            "end": args.end,
            "signal_year": year,
            "stocks": [],
        }
        for name, code, explicit_role in args.stocks:
            classification = classifications.get(code, {})
            role = explicit_role or classification.get("role")
            if role is None:
                raise ValueError(
                    f"{code} has no company role. Add it to the classification config "
                    "or pass NAME=CODE=weight|emotion|dual."
                )
            classification_source = (
                "command_line_override" if explicit_role else "classification_config"
            )
            bars = fetch_bars(code, args.start, args.end)
            events = scan_stock(name, code, role, bars, year)
            result["stocks"].append(
                {
                    "name": name,
                    "code": code,
                    "company_role": role,
                    "classification_source": classification_source,
                    "classification_label": classification.get(
                        "classification_label"
                    ),
                    "classification_rationale": classification.get("rationale"),
                    "classification_confidence": classification.get("confidence"),
                    "classification_reviewed_at": classification.get("reviewed_at"),
                    "bar_count": len(bars),
                    "events": events,
                }
            )
    finally:
        bs.logout()

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
