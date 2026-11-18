// Learning: the role's notebook, its shelf of manuals, the association that brings a page up when it matters, and the
// night's check. All of it is HH's own (src/learning, src/persona/skills.ts, configured by `learning.*`); this
// declaration only lets `hh modules` list it.
import { defineModule } from "../../src/modules/api.ts";
import { loadOpenAIKey } from "../../src/memory/events/embed.ts";

export default defineModule({
  name: "learning",
  summary: "the notebook, the shelf of manuals and the association that brings a page up (HH's own, src/learning)",
  required: true,
  // without an OpenAI key (secrets.json in the state directory) the association finds pages by their words only
  async check(m) {
    return [loadOpenAIKey(m.role.stateDir)
      ? { status: "ok", text: "pages are found by meaning (OpenAI key)" }
      : { status: "ok", text: "no OpenAI key: pages are found by their words only (hh openai set adds one, to find them by meaning)" }];
  },
});
