import { defineCommand } from "citty";
import { getPackageVersion, PACKAGE_NAME } from "../lib/package.js";

export default defineCommand({
  meta: {
    name: "version",
    description: "Show vvoc package version.",
  },
  async run() {
    console.log(`${PACKAGE_NAME} ${await getPackageVersion()}`);
  },
});
