import path from "node:path";
import process from "node:process";
export function solidConfig(major, plugin) {
  const target = process.env.XP_SOLID_TARGET;
  const server = target === "server";
  const entry = path.resolve(".cache/src/index.tsx");
  return {
    plugins: [plugin(major === 1 ? { ssr: true, hot: false } : { ssr: true, refresh: false })],
    build: {
      ssr: server ? entry : false,
      lib: { entry, formats: ["es"] },
      outDir: "../../../dist/client/solid",
      emptyOutDir: false,
      minify: false,
      rolldownOptions: {
        external: (id) =>
          id === "../gates.js" ||
          id.startsWith("solid-js") ||
          id.startsWith("@solidjs/") ||
          id === "@frostme/xp/client",
        output: { entryFileNames: `v${major}.${target}.js` },
      },
    },
  };
}
