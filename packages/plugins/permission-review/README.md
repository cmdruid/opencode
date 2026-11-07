# @cmdcode/opencode-auto-permissions

Experimental model-assisted permission review and session controls for OpenCode. A reviewer can approve one request, deny it with feedback, or leave it for a human. Chat models and decision classifiers use the same contract.

**Publication is on hold.** Version `0.1.0-alpha.2` is an independently versioned local preparation artifact with `private: true`. npm installation is forthcoming; no registry availability or upstream compatibility is claimed.

## Compatible host and local installation

Use the `custom` fork at [cmdruid/opencode](https://github.com/cmdruid/opencode/tree/custom) with permission evaluation and `experimental.review` hooks, plugin RPC/storage, model/provider/credential APIs, and TUI `ui.experimental.permissions.mode()` / `.action()` support. The public `@opencode/plugin@2.2.5` lacks the review hook types: satisfying the peer version alone is insufficient. The host supplies the shared plugin SDK, Effect, Solid and OpenTUI runtimes; this package does not bundle copies. See [verification notes](https://github.com/cmdruid/opencode/blob/custom/packages/plugins/permission-review/VERIFICATION.md) for the exact tested artifact.

From this package directory, run `bun run build` for a source checkout, or `bun run pack /tmp/permission-package` for a tarball. Install the tarball in a separate directory with your package manager, then register its absolute package directory on the server:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/node_modules/@cmdcode/opencode-auto-permissions",
      "options": {
        "model": { "providerID": "your-provider", "id": "your-model" },
        "mode": "chat",
        "defaultMode": "shadow",
      },
    },
  ],
}
```

The model must exist on that server. Installing this package alone does not activate it. Root and `./server` export the server plugin as TypeScript; `./tui` exports a companion compiled with OpenTUI's Solid transform because the host does not transform JSX inside `node_modules`. The connected TUI discovers that companion automatically.

Start with **Shadow — suggest only; you decide**. Keep every connected client in **/settings → Session → Permissions → Prompt**, without `--auto`. Client auto accept can otherwise answer escalated prompts. This plugin refuses session-control changes when the current client uses auto accept; it does not change client preferences.

## Permissions and settings

Open `/permissions` or **Permissions** in the command palette:

| Quick preset     | Additional scope restrictions                                                   | Reviewer |
| ---------------- | ------------------------------------------------------------------------------- | -------- |
| Read only        | Ask for edits, shell, network and other tools                                   | Human    |
| Ask for approval | Allow ordinary local edits; ask for shell, network and outside-directory access | Human    |
| Approve          | Same scope as Ask for approval                                                  | Model    |
| Full access      | No additional plugin restrictions; configured asks and denials remain           | Human    |

Full access requires confirmation with **Go back** selected initially. Scope and reviewer are independent; changing the reviewer preserves scope. Custom combinations show their actual values without falsely marking a quick preset active.

**Settings** has six sections:

| Section        | Configuration                                                      | Scope                       |
| -------------- | ------------------------------------------------------------------ | --------------------------- |
| Classifier     | Provider, decision model/variant, connection, confidence threshold | All sessions on this server |
| Reviewer       | Provider, chat model/variant, connection, timeout, removal         | All sessions on this server |
| Session Policy | Automation Mode, Classifier Mode, Reviewer Mode                    | Current session             |
| Global Policy  | Automation Mode, Classifier Mode, Reviewer Mode                    | All sessions on this server |
| Review Rules   | Exact reviewed actions and additional instructions                 | All sessions on this server |
| Activity       | Review history, remembered approvals, effective permissions        | Current session             |

Menus use compact native OpenCode selection rows, right-aligned values and help for the selected row. There is no search/filter input. Arrows select, Enter opens, and PgUp/PgDn scroll. Home/End select the first/last row. Escape returns one level, preserving the parent selection and scroll position; at the permissions selector it closes. Editors use Ctrl+S to save and Escape to discard. Errors preserve the draft. Connections use one draft and an explicit **Save connection** action. History details return to history, and approval details/revocation return to the approvals list.

Opening settings on the home screen creates no session. Session/activity sections explain their empty state. Selecting a quick preset creates a session only when needed; it runs no model or tool.

Effective server values resolve from built-in defaults, configuration-file options, then sparse saved overrides. Selected-row help identifies the source of saved model, threshold and policy values. **Ctrl+R — Reset to Defaults** opens a confirmation for the current section and removes its saved overrides, restoring configuration-file values or built-in defaults. From the settings overview, the shortcut first asks which section to reset. Model sections reset model choices and tuning; connection overrides reset within their Connection screen. Escape cancels without changing settings. Text editors keep their normal editing keys. Clearing instructions saves empty text, removing the reviewer saves disabled state, **All actions** overrides a configured subset, and an empty action list means **No actions**. Common action choices and custom exact action names are supported.

Session scope/reviewer selections inherit from the nearest explicitly selected ancestor; otherwise they use the server default. Reviewer mode overrides belong only to the current session. Both policy pages expose the same three controls: Automation Mode (Classifier, Reviewer, Both), Classifier Mode (Manual, Shadow, Approve), and Reviewer Mode (Off, Shadow, Approve). Session Automation Mode and Reviewer Mode override Global Policy only for the current session; classifier policy retains existing ancestor inheritance. Resetting Session Policy removes all three overrides. Review Rules holds action filtering and additional instructions. Changes refresh connected readers and apply to subsequent reviews; an assessment already running keeps its starting configuration. Allow Session also rechecks requests already pending for the same session and action. Current rules and reviewer modes still apply; only approvals settle requests, and other outcomes remain pending. This requires the fork host’s `experimental.permission.reviewPending` API.

The plugin ID and storage namespace remain `opencode.permission-review`. Historical session selections, connection identities, remembered approvals and history remain readable. Custom connections resolve the final configured model catalog, including late model definitions and variants. Superseded experimental settings RPCs and the former `/permissions-test`, `/permission-reviews`, and `/session-approvals` commands are removed. Use the single settings flow.

## Configuration-file options

These remain the baseline under saved settings. Settings do not rewrite your config file.

| Option               | Default / meaning                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `reviewWith`         | `classifier`, `reviewer`, or `both`; defaults to `both`                                         |
| `model`              | Required `{ providerID, id, variant? }`                                                         |
| `mode`               | `chat`; choose `decision` for a classifier                                                      |
| `defaultMode`        | `manual`, `shadow`, or `auto`; when omitted, legacy `shadow: true` means shadow, otherwise auto |
| `reviewerMode`       | `off`, `shadow`, or `auto`; defaults to the existing `fallback.mode` (or legacy chat mode)      |
| `shadow`             | Legacy default selector; ignored when `defaultMode` is present                                  |
| `minConfidence`      | `0.98`, inclusive range 0–1; shown only for classifiers                                         |
| `actions`            | Omitted means all exact permission action names; `[]` means none                                |
| `policy`             | No additional instructions; supplements internal reviewer instructions                          |
| `fallback.model`     | Optional chat model reference; omission disables the chat reviewer                              |
| `fallback.mode`      | `shadow`; also `off` or `auto`                                                                  |
| `fallback.timeoutMs` | `10000`, integer range 100–15000 ms                                                             |

The threshold routes decisions; it is not a calibrated probability of safety. Model choices and variants come from the host catalog and are validated on save. Token limits and other generation settings belong to model variants. The Classifier picker only offers decision models and saves `mode: "decision"`; the Reviewer picker only offers chat models. **Provider** chooses a provider and model together; **Model** goes directly to models from the selected provider. Cancelling either picker preserves the saved choice. **Global Policy → Automation Mode** chooses classifier-only, reviewer-only, or combined review. Reviewer-only uses the configured chat model without calling the classifier; its Off/Shadow/Automatic setting and timeout still apply. Classifier-only never calls the chat reviewer. Reviewer-only uses Reviewer Mode independently of the inactive classifier mode. Manual quick presets still require human decisions. In combined mode, classifier Manual/Shadow and the existing agreement rules remain in force. Legacy configuration-file `mode: "chat"` also supports reviewer-only operation with `model` as the chat model.

Connection URLs must be HTTP(S), include any API prefix such as `/v1`, and contain no embedded credentials, query or fragment. Choose the configured provider, no authentication, a new API key, or retain the saved key for an unchanged endpoint. A changed endpoint never inherits the previous key. Saved keys are never prefilled or returned in settings responses; credentials stay in the host credential store. Plugin KV stores only connection metadata. Restoring the configured provider removes the override; old credentials can remain in the host store. Classifier and reviewer connection identities are separate; custom endpoints do not copy the original provider's headers.

## Decision rules and limitations

Permission precedence remains **OpenCode effective rules → additional preset restrictions → selected reviewer for remaining asks**. Denials remain denied. Restrictive presets may tighten saved grants without deleting them. Full access does not relax a configured ask or deny. Requests outside the action filter go to the human. These are approval policies, **not an OS sandbox**: an approved command runs with the account's access.

A classifier can consult a stateless chat reviewer:

| Classifier result                                       | Chat reviewer | Effect in Automatic mode                            |
| ------------------------------------------------------- | ------------- | --------------------------------------------------- |
| Approve at/above threshold                              | Not called    | Classifier approval                                 |
| Approve below threshold                                 | Called        | Approve only when chat independently agrees         |
| Escalate                                                | Called        | Human still decides                                 |
| Deny                                                    | Not called    | Existing denial or below-threshold human escalation |
| Invalid/missing response or oversized required evidence | Not called    | Human decides                                       |

Chat disagreement, errors and timeouts retain the prompt. Reviewer Shadow records advice without changing the classifier decision; automation Shadow always leaves the decision to a human. The host's overall review deadline still applies. Both models receive the same evidence without seeing each other's answer and cannot call tools. Configure one approval reviewer; an earlier hook's result is respected.

The selected provider receives the full permission request, relevant user messages and matching tool inputs, directory/context, additional policy, and up to four relevant completed prior tool-result excerpts (up to 6000 characters each). Assistant prose/reasoning, the current/future tool result and future “Always allow” save patterns are excluded. Prior tool output is evidence, not authorization. Required evidence over 48000 characters escalates; the plugin does not silently shorten the proposed command. Compaction can remove instructions, and parent authorization is not retrieved for subagents. Model review can still fail under prompt injection; model confidence or agreement is not proof of authorization.

## Allow Session and activity

**Allow Session** in the native prompt approves that pending request once and remembers its exact action, resources, metadata, matching tool input, directory, timestamp and latest user-message ID. Future requests are still reviewed, using up to 20 same-action examples from this Session ID. Added effects, different targets and later restrictions require fresh authorization. **Allow once**, ordinary replies, model decisions and successful execution do not create examples. **Always allow** continues through Core's saved permission rules.

Examples survive reloads but do not inherit to children/forks. Inspect or revoke them under **Settings → Activity → Remembered approvals**. Revocation affects subsequent reviews. Deleting a session does not currently purge its plugin KV records.

**Activity → Review history** shows the latest 50 completed assessments, including reasons, threshold/raw scores and chat reviewer outcomes when present. A stored review is not proof of execution or of how a user replied. Core timeouts/hook defects can leave a prompt without a completed assessment. Reasons and assessments are logged/stored server-side.

See the [evaluation guide](https://github.com/cmdruid/opencode/blob/custom/packages/plugins/permission-review/evaluation/README.md) for inert fixtures and recorded model trials. Deterministic tests verify software behavior, not a model's judgment quality.

## Package verification and future release

Run `bun run check:package <tarball> <compatible-opencode-binary>` for an isolated package check. It verifies the payload and host activation using temporary configuration, storage and local fixtures. It does not publish or access normal user sessions.

The package is excluded from host version rewriting and host publication collection. A future release requires verifying npm scope ownership/name availability, reviewing compatibility and verification evidence, and explicitly removing `private: true`. Prepared publication metadata selects public access and the `next` tag; no publication job is enabled.

MIT; see LICENSE.
