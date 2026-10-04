/**
 * dsh-bash-terminal client plugin (DSH 0.2.0 settings seam).
 *
 * WHERE THE FORM ACTUALLY RENDERS
 * -------------------------------
 * The Plugins page does not render a form just because `settings.describe()`
 * serves a namespace. Three separate surfaces exist, each fed by a slot:
 *
 *   plugins.item           kind "list"  -> an extra card + its own page (id)
 *   plugins.bundle.config  kind "keyed" -> a section on the BUNDLE detail page
 *                                          (key = npm package name)
 *   plugins.row.config     kind "keyed" -> the form on a ROW detail page
 *                                          (key = "<package name>#<row id>")
 *
 * RowDetail calls:
 *   renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key })
 * so a row-config component receives `form` (the namespace's ConfigForm) plus
 * whatever its slot registration injects via `inject()`. `form.mutate(ops, rev)`
 * writes through to the Host; `form.state` is the revision-bearing snapshot.
 *
 * We register the row surface keyed exactly as the page computes it, so the
 * "Default terminal" field lands on the dsh-bash-terminal row's page. Registering
 * `plugins.bundle.config` under the package name is what makes the bundle page
 * show its configuration section at all. The Host namespace key remains the
 * loader entry id (`tool-bash-terminal`).
 */

import { SegmentedControl, SettingsForm } from "@deepseek-ai/dsh-client-ui-primitives";
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

/** Settings namespace key: the Host entry id declared by cordis.patch.yml. */
const NAMESPACE = "tool-bash-terminal";
/** npm package name, as the profile and the Plugins page see it. */
const BUNDLE = "dsh-bash-terminal";
/** The row id this bundle's cordis.patch.yml declares. */
const ROW_ID = "tool-bash-terminal";
/** Key the Plugins page looks this row's configuration up under. */
const ROW_KEY = BUNDLE + "#" + ROW_ID;
/** Dictionary namespace owned by this plugin. */
const NS = "settings.bashTerminal";
/** The one config field this page edits. */
const FIELD = "defaultShell";
/** The closed set of backends the Host accepts, in picker order. */
const SHELLS = ["powershell", "gitbash", "wsl"];

/** Required services (cordis fiber inject). */
export const inject = ["slots", "locale", "configForms"];

const zh = {
  title: "默认终端",
  description: "shell 与 terminal 工具使用的终端",
  field: "默认终端",
  fieldHint: "点击即保存，改动在下次启动后生效。注意：交互式终端（terminal 工具）在 WSL 下可能不可用。",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL",
  overridden: "已覆盖",
  reset: "恢复默认",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这个值，已保留供你修改。"
};

const en = {
  title: "Default terminal",
  description: "Terminal used by the shell and terminal tools",
  field: "Default terminal",
  fieldHint: "Saves on click; takes effect after the next start. Note: the interactive terminal tool may be unavailable under WSL.",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "The deployment did not accept this value; it was left for you to correct."
};

/** The form frame's copy, read from this page's dictionary. */
function formLabels(t) {
  return {
    unavailable: t("unavailable"),
    readOnly: t("readOnly"),
    saveFailed: t("saveFailed"),
    save: t("save"),
    saving: t("saving")
  };
}

/**
 * The row's page: the "Default terminal" picker.
 *
 * A pick WRITES IMMEDIATELY -- there is no staged draft and no Save step. The
 * value is a closed set of three backends, every change restarts the entry to take
 * effect anyway, and a save button for a single toggle would only add a step. The
 * SettingsForm shell is kept for its read-only notice and its failure line, with
 * `dirty` pinned false so its (now pointless) Save button stays disabled.
 *
 * The control is a SegmentedControl rather than SettingsValueField: the latter
 * hardcodes a single-line text input and accepts no custom control, and this value
 * is a closed set, so a segmented picker is more accurate and impossible to typo.
 */
function BashTerminalRow(props) {
  const { t, form } = props;
  // The last value the Host accepted. The shared form only re-reads on its next
  // mirror load, so without this the picker snapped back to the pre-write value
  // right after a successful write -- it had landed, but the UI looked like it
  // had not.
  const [accepted, setAccepted] = useState(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (props.view === "summary") return t("description");

  const snapshot = form.state;
  const stored = snapshot && snapshot.value ? snapshot.value[FIELD] : undefined;
  const current = accepted !== null ? accepted : stored;
  const selected = typeof current === "string" ? current : "";
  const writable = Boolean(snapshot && snapshot.writable);

  const commit = (next) => {
    if (!writable || next === current) return;
    setPending(true);
    setFailed(false);
    Promise.resolve(form.mutate([{ op: "set", path: [FIELD], value: next }], snapshot.revision)).then(
      (ok) => {
        setPending(false);
        if (ok === false) setFailed(true);
        else setAccepted(next);
      },
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  };

  const options = SHELLS.map((value) => ({ value, label: t("shell." + value) }));

  return jsx(SettingsForm, {
    labels: formLabels(t),
    state: {
      available: true,
      writable,
      // Pinned false: this form has no staged draft, so its Save stays disabled.
      // `failed` is rendered independently of it, so write failures still show.
      dirty: false,
      invalid: false,
      saving: pending,
      failed
    },
    onSave: () => {},
    onDiscard: () => setFailed(false),
    children: jsxs("fieldset", {
      style: { border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 },
      disabled: !writable,
      children: [
        jsx("legend", {
          style: { padding: 0, fontSize: 13, color: "var(--dsw-alias-label-primary)" },
          children: t("field")
        }),
        jsx(SegmentedControl, {
          id: "plugin-config-bash-terminal-shell",
          value: selected,
          options,
          label: t("field"),
          disabled: !writable || pending,
          onChange: commit
        }),
        jsx("p", {
          style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
          children: t("fieldHint")
        })
      ]
    })
  });
}

/** One-line summary for the bundle detail page's configuration section. */
function BashTerminalBundleSummary(props) {
  return props.t("description");
}

export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "bash-terminal: settings dictionaries");

  // Register both surfaces while the Host serves the namespace, so a deployment
  // that never composes this bundle shows no trace of either.
  ctx.effect(
    () =>
      ctx.configForms.whileServed([NAMESPACE], () => {
        const offRow = ctx.slots.inject(
          "plugins.row.config",
          () =>
            ctx.slots.register(
              { name: "plugins.row.config", key: ROW_KEY, locale: NS, inject: () => ({}) },
              BashTerminalRow
            )
        );
        const offBundle = ctx.slots.inject(
          "plugins.bundle.config",
          () =>
            ctx.slots.register(
              { name: "plugins.bundle.config", key: BUNDLE, locale: NS, inject: () => ({}) },
              BashTerminalBundleSummary
            )
        );
        return () => {
          offRow();
          offBundle();
        };
      }),
    "bash-terminal: plugins row page"
  );
}
