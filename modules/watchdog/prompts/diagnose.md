"{me}", a role running on Human Harness, has lost a channel and the watchdog's fixed recovery did not mend it.
Symptom: [{kind}] {what}

Find where the problem is. You may look at: the watchdog's incident record {incidents}; the role's state directory {state_dir} (logs/hh.jsonl, one JSON line each — use tail, grep, jq; channels/ holds each bridge's log); `launchctl list` and `launchctl print` for its jobs.
{background}

Rules (they are not optional):
- Read only. Change no file, no config, no session; restart nothing; send no message. Whether to fix is {owner}'s decision.
- Do not copy private chat content from the logs into the report.
- Your whole output is the report to {owner}: plain words, at most 900 characters — what happened / where the problem is (which log, near which line) / how you would fix it / what {owner} has to decide.
