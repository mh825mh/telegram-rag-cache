import { type PluginContext } from "@lmstudio/sdk";
import { buildConfigSchematics } from "./config.js";
import { toolsProvider } from "./toolsProvider.js";

export async function main(context: PluginContext) {
  context.withConfigSchematics(buildConfigSchematics());
  context.withToolsProvider(toolsProvider);
}