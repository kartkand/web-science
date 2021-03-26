/**
 * WebScience Intermediate Build Step
 * -----------------------
 *   * Copy background script files to an intermediate directory.
 *   * Bundle content script dependencies into IIFE content scripts, and
 *     copy the bundled content script files to the intermediate directory.
 */

import copy from "rollup-plugin-copy";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import globby from "globby";

const sourceDirectory = "src";
const intermediateDirectory = "intermediate";

export default (cliArgs) => {
  // Background script files
  const rollupConfig = [{
    input: ".empty.js", // Rollup requires an input file
    plugins: [
      copy({
        targets: [{
          src: [
            `${sourceDirectory}/**/*.js`,
            `!${sourceDirectory}/**/*.content.js`
          ],
          dest: `${intermediateDirectory}`
        }],
        flatten: false
      })
    ]
  }];

  // Content script files
  const contentScriptPaths = globby.sync(`${sourceDirectory}/**/*.content.js`);
  for(const contentScriptPath of contentScriptPaths) {
    rollupConfig.push({
      input: contentScriptPath,
      output: {
        file: `${intermediateDirectory}${contentScriptPath.slice(sourceDirectory.length)}`,
        format: "iife"
      },
      plugins: [
        commonjs(),
        resolve({
          browser: true
        })
      ]
    });
  }
  return rollupConfig;
}
