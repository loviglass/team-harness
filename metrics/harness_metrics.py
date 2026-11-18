#!/usr/bin/env python3
"""Token report for OpenCode sessions (read-only).

Answers one question per root session: how much context did the lead (root) model
consume, and on what — hands-on work, delegation, or talk. Works on any OpenCode
1.x database, so the old harness and team-harness can be compared directly.

  harness_metrics.py --db PATH [--since YYYY-MM-DD] [--json]
"""
import argparse
import collections
import datetime as dt
import json
import sqlite3
import sys

HANDS_ON = {"bash", "read", "edit", "write", "grep", "glob", "list", "patch", "apply_patch", "multiedit"}
DELEGATION = {"task", "background_task"}
AUX_AGENTS = {"compaction", "title", "summary"}


def load(db_path, since_ms):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    sessions = {}
    for sid, parent, title, created in db.execute("select id, parent_id, title, time_created from session"):
        sessions[sid] = {"id": sid, "parent": parent, "title": title, "created": created}
    messages = {}
    for mid, sid, data in db.execute("select id, session_id, data from message"):
        messages[mid] = (sid, json.loads(data))
    steps = []
    current = collections.defaultdict(list)
    for mid, data in db.execute("select message_id, data from part order by message_id, id"):
        sid, msg = messages.get(mid, (None, {}))
        if msg.get("role") != "assistant":
            continue
        p = json.loads(data)
        kind = p.get("type")
        if kind == "step-start":
            current[mid] = []
        elif kind == "tool":
            current[mid].append(p.get("tool"))
        elif kind == "compaction":
            current[mid].append("_compaction")
        elif kind == "step-finish":
            tok = p.get("tokens") or {}
            cache = tok.get("cache") or {}
            steps.append({
                "session": sid,
                "agent": msg.get("agent"),
                "model": msg.get("modelID"),
                "input": tok.get("input", 0),
                "cache_read": cache.get("read", 0),
                "cache_write": cache.get("write", 0),
                "output": tok.get("output", 0),
                "reasoning": tok.get("reasoning", 0),
                "tools": current.pop(mid, []),
            })
    db.close()

    def root_of(sid):
        seen = set()
        while sessions.get(sid, {}).get("parent") and sid not in seen:
            seen.add(sid)
            sid = sessions[sid]["parent"]
        return sid

    steps = [s for s in steps if s["session"] in sessions and sessions[root_of(s["session"])]["created"] >= since_ms]
    for s in steps:
        s["root"] = root_of(s["session"])
        s["is_root"] = s["root"] == s["session"]
        s["ctx"] = s["input"] + s["cache_read"] + s["cache_write"]
    return sessions, steps


def classify(tools):
    tools = set(tools)
    if tools & DELEGATION:
        return "delegation"
    if tools & HANDS_ON:
        return "hands_on"
    if tools:
        return "other_tool"
    return "text"


def report(sessions, steps):
    roots = collections.OrderedDict()
    for s in steps:
        r = roots.setdefault(s["root"], {
            "title": sessions[s["root"]]["title"],
            "lead_models": collections.Counter(),
            "lead_steps": 0, "lead_ctx": 0, "lead_out": 0, "lead_max_ctx": 0,
            "by_kind": collections.Counter(), "lead_tools": collections.Counter(),
            "child_sessions": set(), "child": collections.Counter(), "child_steps": collections.Counter(),
            "compactions": 0,
        })
        if s["agent"] in AUX_AGENTS:
            r["compactions"] += s["agent"] == "compaction"
            r["child"][f"{s['agent']}/{s['model']}"] += s["ctx"]
            continue
        if s["is_root"]:
            r["lead_models"][f"{s['agent']}/{s['model']}"] += 1
            r["lead_steps"] += 1
            r["lead_ctx"] += s["ctx"]
            r["lead_out"] += s["output"] + s["reasoning"]
            r["lead_max_ctx"] = max(r["lead_max_ctx"], s["ctx"])
            r["by_kind"][classify(s["tools"])] += s["ctx"]
            r["lead_tools"].update(t for t in s["tools"] if not t.startswith("_"))
        else:
            r["child_sessions"].add(s["session"])
            key = f"{s['agent']}/{s['model']}"
            r["child"][key] += s["ctx"]
            r["child_steps"][key] += 1

    per_model = collections.defaultdict(lambda: collections.Counter())
    for s in steps:
        m = per_model[f"{'root' if s['is_root'] else 'child'}:{s['agent']}/{s['model']}"]
        m["steps"] += 1
        m["ctx"] += s["ctx"]
        m["input"] += s["input"]
        m["cache_read"] += s["cache_read"]
        m["output"] += s["output"] + s["reasoning"]

    out_roots = []
    for rid, r in roots.items():
        if not r["lead_steps"]:
            continue
        out_roots.append({
            "id": rid, "title": r["title"],
            "lead_models": dict(r["lead_models"]),
            "lead_steps": r["lead_steps"], "lead_ctx": r["lead_ctx"], "lead_output": r["lead_out"],
            "lead_avg_ctx": r["lead_ctx"] // r["lead_steps"], "lead_max_ctx": r["lead_max_ctx"],
            "lead_ctx_share": {k: round(v / r["lead_ctx"], 3) for k, v in r["by_kind"].items()} if r["lead_ctx"] else {},
            "lead_tools": dict(r["lead_tools"].most_common()),
            "delegations": sum(r["lead_tools"][t] for t in DELEGATION),
            "child_sessions": len(r["child_sessions"]),
            "child_ctx": dict(r["child"]), "child_steps": dict(r["child_steps"]),
            "compactions": r["compactions"],
        })
    totals = {k: dict(v) | {"cache_hit": round(v["cache_read"] / v["ctx"], 3) if v["ctx"] else None}
              for k, v in sorted(per_model.items(), key=lambda kv: -kv[1]["ctx"])}
    lead_total = sum(r["lead_ctx"] for r in out_roots)
    hands = sum(r["lead_ctx"] * r["lead_ctx_share"].get("hands_on", 0) for r in out_roots)
    return {
        "summary": {
            "root_sessions": len(out_roots),
            "lead_ctx_total": lead_total,
            "lead_hands_on_share": round(hands / lead_total, 3) if lead_total else None,
            "all_ctx_total": sum(s["ctx"] for s in steps),
        },
        "by_agent_model": totals,
        "roots": sorted(out_roots, key=lambda r: -r["lead_ctx"]),
    }


def fmt(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else f"{n / 1e3:.0f}K"


def print_text(rep):
    s = rep["summary"]
    print(f"Root sessions: {s['root_sessions']}   lead ctx: {fmt(s['lead_ctx_total'])}   "
          f"lead hands-on share: {s['lead_hands_on_share']}   all ctx: {fmt(s['all_ctx_total'])}\n")
    print(f"{'agent/model':48} {'steps':>6} {'ctx':>8} {'avg':>6} {'cache':>6}")
    for k, v in rep["by_agent_model"].items():
        print(f"{k:48} {v['steps']:6} {fmt(v['ctx']):>8} {fmt(v['ctx'] // max(v['steps'], 1)):>6} {v['cache_hit'] or 0:6.0%}")
    print()
    for r in rep["roots"]:
        share = " ".join(f"{k}={v:.0%}" for k, v in sorted(r["lead_ctx_share"].items(), key=lambda kv: -kv[1]))
        print(f"• {r['title'][:70]}")
        print(f"  lead {','.join(r['lead_models'])}: {r['lead_steps']} steps, {fmt(r['lead_ctx'])} ctx "
              f"(avg {fmt(r['lead_avg_ctx'])}, max {fmt(r['lead_max_ctx'])}), {share}")
        print(f"  delegations {r['delegations']}, children {r['child_sessions']}: "
              + ", ".join(f"{k} {fmt(v)}" for k, v in sorted(r["child_ctx"].items(), key=lambda kv: -kv[1]))
              + (f", compactions {r['compactions']}" if r["compactions"] else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--since", help="only root sessions created on/after YYYY-MM-DD")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    since = 0
    if a.since:
        since = int(dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    rep = report(*load(a.db, since))
    if a.json:
        json.dump(rep, sys.stdout, ensure_ascii=False, indent=1)
        print()
    else:
        print_text(rep)


if __name__ == "__main__":
    main()
