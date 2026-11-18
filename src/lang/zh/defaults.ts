// 中文包带的配置默认值：跟语言有关的那几样（人物卡模板的字段名和写法、学习的通用大类名）。
// 合并时是最低的一层：config/default.json、实例文件（HH_CONFIG）、调用处给的都盖得过它（src/config.ts 的 loadConfig）。
// 模板的结构和校验见 src/memory/events/people.ts 的 parseTemplate；满了时那两句提示不写具体的人（人格自己的说法写在她的实例文件里）
import type { Config, DeepPartial } from "../../config.ts";

export const defaults: DeepPartial<Config> = {
  memory: {
    people: {
      template: {
        "order": ["关系", "感觉", "我们之间", "是谁", "在乎什么", "喜好", "雷点", "相处", "我们的大事", "梗", "约定和边界", "我的理解", "她私下说的", "对我的感情和期待", "记着的原话", "近况"],
        "fields": [
          {
            "name": "关系", "type": "总结", "shape": "line",
            "pattern": "^\\s*[^｜\\s](?:[^｜]{0,6}[^｜\\s])?\\s*｜\\s*(?:更近|平稳|变远)\\s*｜\\s*[^｜\\s](?:[^｜]{0,58}[^｜\\s])?\\s*$",
            "patternHint": "写成「类型｜走向｜一句话」，用全角「｜」隔开：类型 1–8 字（如 朋友、家人、群），走向只能是 更近 / 平稳 / 变远，一句话 1–60 字，如「朋友｜更近｜有心事先来找我」",
            "protect": true
          },
          { "name": "感觉", "type": "总结", "shape": "text", "maxChars": 120, "maxSentences": 2, "owner": { "maxChars": 200, "maxSentences": 3 }, "protect": true },
          { "name": "我们之间", "type": "总结", "shape": "text", "maxChars": 400, "ownerOnly": true, "protect": true },
          { "name": "是谁", "type": "总结", "shape": "text", "maxChars": 150, "owner": { "maxChars": 300 } },
          { "name": "在乎什么", "type": "总结", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 } },
          { "name": "喜好", "type": "总结", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 } },
          { "name": "雷点", "type": "总结", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 } },
          { "name": "相处", "type": "总结", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 } },
          { "name": "我们的大事", "type": "总结", "shape": "list", "maxItems": 20, "itemMaxChars": 60, "ownerOnly": true, "protect": true, "requireEvent": true },
          { "name": "梗", "type": "总结", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 } },
          { "name": "约定和边界", "type": "设定", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "owner": { "maxItems": 8, "itemMaxChars": 60 }, "protect": true },
          { "name": "我的理解", "type": "总结", "shape": "list", "maxItems": 3, "itemMaxChars": 40, "itemMustContain": "〔推断〕", "owner": { "maxItems": 5, "itemMaxChars": 60 } },
          { "name": "她私下说的", "type": "详情", "shape": "list", "maxItems": 5, "itemMaxChars": 40, "private": true }
        ],
        "quotes": [
          { "name": "对我的感情和期待", "max": 3, "ownerMax": 12, "countsTowardTotal": true, "replaceable": true, "speaker": "self" },
          { "name": "记着的原话", "max": 40, "countsTowardTotal": false, "replaceable": false, "speaker": "selfOrMe", "fullHint": "照主人定的规矩不挤掉，写进给主人的提案", "fullHintOthers": "不挤掉；回报里只写「<名字> 的记着的原话满了」，不写原话" }
        ],
        "computed": {
          "bigEvents": { "name": "我们的大事", "minImportance": 4, "max": 10 },
          "near": { "name": "近况", "days": 14, "max": 5 }
        },
        "totalCap": 1500,
        "ownerTotalCap": 4500,
        "computedOnlyMinImportance": 3,
        "promote": { "days": 14, "minDays": 3 }
      },
    },
  },
  learning: { generalCategory: "通用", archiveDir: "归档", residentFile: "常驻.md" },
};
