# navigation.outcome

Mechanism: what NavigationDecision answers -- a dock to navigate (`dock` + `address`), OR a
`prompt` for the assistant, never both; `decision` and `candidates` say how. A file, URL or
web-app target leaves both empty: the UI builds that dock from `decision.target`.
