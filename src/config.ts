import { createConfigSchematics } from "@lmstudio/sdk";

export function buildConfigSchematics() {
  return createConfigSchematics()
    .field("historyWindow", "select", {
      options: [
        { value: "1w", displayName: "1 Week" },
        { value: "1m", displayName: "1 Month" },
        { value: "3m", displayName: "3 Months" },
        { value: "6m", displayName: "6 Months" },
        { value: "9m", displayName: "9 Months" },
        { value: "12m", displayName: "12 Months" },
        { value: "24m", displayName: "24 Months" }
      ]
    }, "1m")
    .field("maxCachedMessages", "numeric", {
      min: 100, max: 50000, step: 100, int: true
    }, 5000)
    .field("defaultFetchPages", "numeric", {
      min: 1, max: 50, step: 1, int: true
    }, 5)
    .field("searchResultLimit", "numeric", {
      min: 1, max: 50, step: 1, int: true
    }, 10)
    .build();
}