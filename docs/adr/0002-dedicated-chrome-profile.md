# ADR 0002: Dedicated Chrome profile and CDP port

Status: accepted

browser-control uses `~/browser-control/chrome-profile` and CDP port `19313`. It does not use the user's daily Chrome profile or the legacy browser-agent profile/port.

The Controller connects to CDP once and keeps the Playwright Browser object in memory until a real disconnect or reset occurs.

