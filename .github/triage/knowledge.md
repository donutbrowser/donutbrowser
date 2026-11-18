# Donut Browser: facts for issue triage

Public facts only. The triage model reads this file and nothing else from the repository.

## Product

- Donut Browser is a desktop app for macOS, Windows and Linux. It makes browser profiles and starts each one in its own browser window.
- The browser engine is Wayfern, a Chromium fork from the same maintainer. A Wayfern problem is in scope here.
- Other forks of Chromium or of Wayfern are not supported.
- Each profile has its own fingerprint, cookies, extensions, and proxy or VPN.
- Proxies: HTTP, HTTPS, SOCKS4, SOCKS5, and Xray share links (VLESS, VMess, Trojan, Hysteria2). VPN: WireGuard.
- Sync is optional. It uses Donut cloud or a `donut-sync` server that the user hosts. Self-hosted sync is free.
- Automation: a local REST API, and MCP for AI agents. Some automation needs a paid plan. Plans are on https://donutbrowser.com/pricing. Never state prices or the contents of a plan.
- Install kinds: macOS DMG or Homebrew; Windows installer or portable ZIP; Linux deb, rpm, AppImage, Flatpak, Snap, Nix.
- Docs: https://donutbrowser.com/docs. The only sources of truth are donutbrowser.com and github.com/donutbrowser.

## Areas

Use these names in `areas`.

- `profiles`: create, edit, import, groups, templates, statuses, trash, profile lock.
- `launch`: a profile does not start, stops, or the browser download fails.
- `wayfern`: page rendering, site compatibility, browser crashes, browser performance.
- `fingerprint`: detection by a site or a test page, fingerprint values, cross-OS profiles.
- `proxy`: proxies, Xray links, proxy check, DNS blocklists, traffic.
- `vpn`: WireGuard.
- `sync`: cloud sync, self-hosted sync, encryption, teams.
- `automation`: REST API, MCP, CDP, Playwright, Puppeteer, Selenium, the agent.
- `extensions`: extensions and extension groups.
- `cookies`: cookie import, export, Cookie Bot.
- `install`: install, update, packages, app start.
- `ui`: layout, themes, translations, shortcuts, settings.
- `account`: sign-in, plan, billing.

## Facts that decide a bug, by area

Ask only for a fact that is absent from the issue and that changes what the maintainer does next.

- `launch`: the exact error text. Whether a new profile with no proxy starts. Which antivirus, firewall, VPN client or device-management software runs on the computer.
- `wayfern`: a public page or a small file that shows the problem. Whether the same page works in Chrome on the same computer. Whether it occurs in a new profile.
- `fingerprint`: the test page and the exact value or verdict it shows. Whether the profile uses a proxy, and of which kind (residential, datacenter, mobile). Whether the profile OS is the same as the computer OS.
- `proxy`: the proxy protocol. Whether the proxy check in the app passes. Whether the same proxy works outside Donut (for example with curl). Whether the problem occurs with no proxy. Never ask for the proxy address or credentials.
- `vpn`: whether the same WireGuard config connects in the WireGuard app. Whether the problem occurs with no VPN.
- `sync`: Donut cloud or self-hosted. The app version on each device. Whether encryption is on. The `donut-sync` version for a self-hosted server.
- `automation`: REST API or MCP. The endpoint or tool name, the HTTP status and the response text. The client (Playwright, Puppeteer, Selenium, or the MCP client name). Whether the app shows a message about a plan.
- `install`: the install kind. For Linux: the distribution and its version, and Wayland or X11. For macOS: the macOS version, and Apple Silicon or Intel. For Windows: Windows 10 or 11.
- `ui`: a screenshot. The theme, the window size and the app language when they are related.
- `account`: never ask for an email, a token or payment data. Send account and billing problems to contact@donutbrowser.com.
- Regression (an earlier version worked): the last version that worked.

## Known signatures

When the issue text matches one, put the given text in `answer` and ask the given question first.

- `CDP not ready after` with `HTTP 5` (for example `HTTP 503`): software on the computer intercepts local connections. Answer: "This error occurs when software on the computer intercepts local connections to the browser." Question: "Which antivirus, firewall, VPN client or device-management software runs on this computer, and does the profile start with its web shield off?"
- `error while loading shared libraries: libfuse` or an AppImage that stops at start: Answer: "The AppImage needs libfuse2, or start it with `APPIMAGE_EXTRACT_AND_RUN=1`." No question.
- `EGL` display error at start on Linux: Answer: "Start the app with `WEBKIT_DISABLE_DMABUF_RENDERER=1`." Question: "Does the app start with that variable set?"

## Not issues for this tracker

- A request to support another browser engine or another fork: not supported. `answer`: "Other engines and forks are not supported." No questions.
- A question on how to use the app: `kind` is `question`. Answer it only when this file has the answer. If not, `answer` is "Questions get faster answers in Discussions: https://github.com/donutbrowser/donutbrowser/discussions".
- A security vulnerability: `answer` is "Report vulnerabilities in private: https://github.com/donutbrowser/donutbrowser/security/policy". No questions.
