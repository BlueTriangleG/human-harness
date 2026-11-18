// Browser: HH's browser tool and `hh browser`, driving the role's own Chrome (configured by `browser.*`). HH's own code
// (src/browser, src/tools/browser.ts); this declaration only lets `hh modules` list it.
import { defineModule } from "../../src/modules/api.ts";

export default defineModule({
  name: "browser",
  summary: "the browser tool: the role's own Chrome (HH's own, src/browser)",
  required: true,
  requires: { setup: ["Google Chrome installed; browser.chrome points at it"] },
});
