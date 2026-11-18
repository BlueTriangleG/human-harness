---
name: sticker-lib
description: Your own sticker library - how to send one (the sticker tool), how to find new ones, how to review them and take them in, how to tidy up, and noting how the other side reacts. Open it when you want a sticker to go with a reply, the weekly reminder to collect stickers has come, or the library needs tidying.
---
# The sticker library (sticker-lib)

## What it is
A sticker library kept in your workspace (`stickers/` by default): `index.json` records for each one its name, description, mood words, tags, whom it is for, its rating, how often it was used and how the other side reacted; `img/` holds the images taken in, `inbox/` the candidates not decided on yet, `trash/` the removed ones (they can be brought back).

## Sending
- Use the **sticker tool**, not the command: `mood` holds mood words ("happy", "speechless", "got it" and the like; several are fine), and it picks one by how well it matches, its rating and the other side's feedback, picking recently sent ones less; `ref` names which ones to send (ids in the library, or image paths inside the library's directory).
- By default it goes to whoever you are talking with; for someone else give `to`.
- On WhatsApp a GIF is turned into a looping video automatically.
- When nothing matches you are told the closest mood words: try another word, or send none this time.

## Finding new ones and taking them in
1. Find: `sticker categories` shows the mood categories; `sticker browse <category> -n 3` downloads a few candidates of a category; `sticker search <title or character> -n 3` finds by work; `sticker grab <image address>` takes one you saw elsewhere. They all land in `inbox/`.
2. Review: `sticker inbox` lists the candidates; look at each (really open the image).
3. Take in: `sticker add <candidate path> --name <short name> --desc <what is in the picture, and when to use it> --moods <mood words, comma-separated> [--tags …] [--for me|<your owner's name>|both] [--rating 1-5] [--source …]`. Write mood words you would really think of while chatting and describe the picture clearly; only then is the picking good later.
4. The ones you do not want: `sticker reject <candidate path…>`.

## Tidying up
- `sticker find <word…>` searches the library; `sticker pick <mood word>` tries a pick (without sending).
- `sticker edit <id> --moods … --desc … --rating …` changes one; `sticker remove <id> --reason …` moves it to trash.
- `sticker feedback <id> liked|disliked [--note …]` notes how the other side reacted: liked ones are picked more, and one disliked twice with nobody liking it is no longer picked.
- `sticker stats` shows the total, the number of candidates, the most used and the disliked.

## Once a week
The stickers module reminds you once a week to collect new stickers. When it comes, take in a few as under "Finding new ones"; skip it if you do not feel like it.

## Common pitfalls
- Look at the image before taking it in: a thumbnail's name and an address do not show the picture, and a wrong one makes for odd sends when it is picked.
- Do not write mood words that are too far-fetched: a word nobody would think of is as good as none.
- Do not let the library only grow: keep the ones in use and clear out those never sent and not liked.
- An image over 5MB is refused at download: a sticker has no need to be that big; take a smaller one.
