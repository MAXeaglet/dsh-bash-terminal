// Build the browser client bundle for dsh-bash-terminal.
// Output: lib/client.js (primary, consumed by DSH loader/reload precheck) and
// dist/client.js (legacy compatibility) — a __ModuleLoader__.load({ id, factory })
// wrapper around the esbuild CJS bundle; shared deps (react, @deepseek-ai/*)
// resolve through the loader's require.

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "dist"), { recursive: true });
mkdirSync(join(root, "lib"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "client.jsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  outfile: join(root, "dist", "client.core.js"),
  external: ["react", "react/jsx-runtime", "react-dom", "@deepseek-ai/*"],
  jsx: "automatic",
  logLevel: "warning"
});

const core = readFileSync(join(root, "dist", "client.core.js"), "utf8");
const wrapper = `window.__ModuleLoader__.load({
	id: "dsh-bash-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${core}
		return module.exports;
	}
});
`;
writeFileSync(join(root, "lib", "client.js"), wrapper);
writeFileSync(join(root, "dist", "client.js"), wrapper);
console.log("built lib/client.js + dist/client.js (" + wrapper.length + " bytes)");
