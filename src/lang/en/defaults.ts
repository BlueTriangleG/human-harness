// The English pack's config defaults: the language-dependent ones (the person card template's field names and how each is
// written; the notebook's general category and its archive and resident file names, as the modules' English manuals use
// them). The lowest layer of the merge: config/default.json, the instance file and the caller's own all win over it
// (loadConfig in src/config.ts). Limits count characters, so they are about two and a half times the Chinese pack's.
import type { Config, DeepPartial } from "../../config.ts";

export const defaults: DeepPartial<Config> = {
  memory: {
    people: {
      template: {
        "order": ["Relationship", "Feeling", "Between us", "Who they are", "What they care about", "Likes", "Sore points", "Getting along", "Our big events", "Running jokes", "Agreements and boundaries", "My reading", "Told me in private", "Feelings and hopes toward me", "Words I keep", "Lately"],
        "fields": [
          {
            "name": "Relationship", "type": "summary", "shape": "line",
            "pattern": "^\\s*[^|\\s](?:[^|]{0,18}[^|\\s])?\\s*\\|\\s*(?:closer|steady|further)\\s*\\|\\s*[^|\\s](?:[^|]{0,148}[^|\\s])?\\s*$",
            "patternHint": "write it as \"kind | direction | one sentence\", separated by \"|\": the kind 1–20 characters (such as friend, family, group), the direction only closer / steady / further, the sentence 1–150 characters, as in \"friend | closer | comes to me first when something is on their mind\"",
            "protect": true
          },
          { "name": "Feeling", "type": "summary", "shape": "text", "maxChars": 300, "maxSentences": 2, "owner": { "maxChars": 500, "maxSentences": 3 }, "protect": true },
          { "name": "Between us", "type": "summary", "shape": "text", "maxChars": 1000, "ownerOnly": true, "protect": true },
          { "name": "Who they are", "type": "summary", "shape": "text", "maxChars": 375, "owner": { "maxChars": 750 } },
          { "name": "What they care about", "type": "summary", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 } },
          { "name": "Likes", "type": "summary", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 } },
          { "name": "Sore points", "type": "summary", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 } },
          { "name": "Getting along", "type": "summary", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 } },
          { "name": "Our big events", "type": "summary", "shape": "list", "maxItems": 20, "itemMaxChars": 150, "ownerOnly": true, "protect": true, "requireEvent": true },
          { "name": "Running jokes", "type": "summary", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 } },
          { "name": "Agreements and boundaries", "type": "setting", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "owner": { "maxItems": 8, "itemMaxChars": 150 }, "protect": true },
          { "name": "My reading", "type": "summary", "shape": "list", "maxItems": 3, "itemMaxChars": 100, "itemMustContain": "[inferred]", "owner": { "maxItems": 5, "itemMaxChars": 150 } },
          { "name": "Told me in private", "type": "detail", "shape": "list", "maxItems": 5, "itemMaxChars": 100, "private": true }
        ],
        "quotes": [
          { "name": "Feelings and hopes toward me", "max": 3, "ownerMax": 12, "countsTowardTotal": true, "replaceable": true, "speaker": "self" },
          { "name": "Words I keep", "max": 40, "countsTowardTotal": false, "replaceable": false, "speaker": "selfOrMe", "fullHint": "by the owner's rule nothing is pushed out: put it in a proposal to the owner", "fullHintOthers": "nothing is pushed out; the report says only \"<name>'s Words I keep is full\", without the words" }
        ],
        "computed": {
          "bigEvents": { "name": "Our big events", "minImportance": 4, "max": 10 },
          "near": { "name": "Lately", "days": 14, "max": 5 }
        },
        "totalCap": 3750,
        "ownerTotalCap": 11250,
        "computedOnlyMinImportance": 3,
        "promote": { "days": 14, "minDays": 3 }
      },
    },
  },
  learning: { generalCategory: "General", archiveDir: "Archive", residentFile: "Resident.md" },
};
