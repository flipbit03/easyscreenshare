import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { MakerZIP } from "@electron-forge/maker-zip";

const config: ForgeConfig = {
  packagerConfig: {
    // Unsigned by design for v0 (docs/research/03): macOS gets the automatic
    // ad-hoc signature from packager; Windows ships unsigned + checksums.
    extraResource: ["assets"],
  },
  makers: [new MakerZIP({})],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [{ name: "picker", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
