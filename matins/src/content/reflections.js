// Hand-written reflections, keyed by GOSPEL PASSAGE rather than by date.
//
// Why by passage: the lectionary brings the same Gospels back round, on
// different dates, in different years. Keying on the reading means a good
// reflection is reused whenever that reading is proclaimed instead of being
// stranded on one square of a calendar. When today's Gospel is in here, the
// model is not asked for a reflection at all.
//
// These skip the LLM safety pass for the same reason the prayers and the Q&A
// do: nothing generated them. That makes the human eye the only gate they get
// — EVERY ENTRY NEEDS READING BEFORE IT SHIPS. Correct them freely; keep the
// `id` stable, because rotation state remembers ids.
//
// The shape is a common devotional one — passage, a few angles on it, a turn
// toward the reader, one line of prayer. Nothing here is adapted from another
// devotional's text.

export const REFLECTIONS = [
  {
    id: 'transfiguration',
    gospel: 'Matthew 17:1-9',
    tags: ['feast', 'glory'],
    body: `Only three of them go up: Peter, James, and John — the same three he will take with him later, on a different night, when he is in agony and wants company. What they see on the mountain is not a different Jesus. It is the one they have been walking behind for months, with the covering taken off for a few minutes.

Moses and Elijah are standing there talking to him. Both of them had met God on a mountain. Neither of them had seen this. Everything the Law and the Prophets spent centuries pointing at is standing in front of them with a face and a name.

Then the voice, and the three of them go down on the ground. That is not the fear of a man expecting punishment. It is what happens to anyone who finds himself standing in front of what does not begin and does not end. He tells them to get up and stop being afraid. He does not tell them to stop being amazed.`,
    turn: 'Not everything in the faith is a problem waiting to be solved. Take the thing about God you understand least and sit with it for five minutes today without trying to crack it.',
    closer: 'Lord, make me slow where I have been clever.',
  },
  {
    id: 'canaanite-woman',
    gospel: 'Matthew 15:21-28',
    tags: ['prayer', 'persistence'],
    body: `She asks, and gets silence. The disciples read the silence the way most men would and ask him to send her away. She keeps asking.

Then a limit that sounds final — he was sent to the lost sheep of Israel, and she is not one of them. She moves closer instead of backing off. Then the hard line about the children's bread, which she picks up and turns around: she will take what falls from the table, and she says so to his face.

He does not soften any of it. He tells her, out loud and in front of the men who wanted her gone, that her faith is great, and her daughter is well from that hour. He was never refusing her. He was drawing out something already in her, in the one place where the disciples could not miss it.`,
    turn: 'There is something you stopped asking God for, because the silence went on longer than you could keep looking foolish. Ask for it again tonight, in the same words you used the first time.',
    closer: 'Lord, teach me to keep asking.',
  },
  {
    id: 'what-defiles',
    gospel: 'Matthew 15:1-20',
    tags: ['ordinary time', 'practice'],
    body: `The Pharisees notice that the disciples skip the ritual washing before they eat, and they complain about it. He tells them that what goes into a man is not what defiles him. What comes out of him is.

He is not throwing out the practice. The washing was never the problem — it had just been allowed to run on its own, as though the water did something the heart had not agreed to. And when he is told he has given offence, he does not walk it back an inch. He calls them blind guides and says that whatever the Father did not plant gets pulled up.

Grace before a meal. The sign of the cross before the engine turns over. A Hail Mary on the way in. Mass on Sunday. Every one of them good, and every one of them worth nothing on autopilot. A man can sit through a whole hour of Mass and carry out exactly what he carried in.`,
    turn: 'Take the one you do most automatically — the fastest, most mumbled one — and mean it once today. Only once. Slowly enough to hear yourself.',
    closer: 'Lord, I have been going through the motions. Take this one back.',
  },
  {
    id: 'walking-on-water',
    gospel: 'Matthew 14:22-33',
    tags: ['trouble', 'fear'],
    body: `He puts them in the boat, sends them ahead, and goes up the mountain by himself to pray. In scripture the mountain is where God gets met — Sinai, Tabor — and he goes up alone, and stays there while they row.

The wind is against them most of the night. He comes in the fourth watch, which is the coldest and latest part of it, and he comes walking on top of the thing that has been beating them for hours. The storm is not an obstacle he has to get around. It is the floor.

And they do not recognise him. They think he is a ghost, and they cry out in fear at the one thing in that whole night that was actually on their side. That is the part worth staying with. In the middle of a bad stretch, help arriving very often looks like one more thing going wrong.`,
    turn: 'Name the thing that has been against you all week, out loud, in the truck or the stairwell. Then say who is walking across the top of it.',
    closer: 'Lord, it is you. Let me stop bracing.',
  },
  {
    id: 'loaves-and-fishes',
    gospel: 'Matthew 14:13-21',
    tags: ['eucharist', 'providence'],
    body: `Five loaves and two fish, and a crowd nobody counted carefully — five thousand men, and then the women and the children who were not in the number at all. He takes the bread, blesses it, breaks it, gives it away. Twelve baskets come back.

Israel had been fed like this before, out in the desert, every morning for forty years, and never with anything left to store. That was the rule: enough for the day and not a crumb more. What is new on this hillside is the surplus. He does not hand out a ration. He gives more than the crowd is able to hold.

All four Gospels keep this account, which is not an accident. Take, bless, break, give is the shape of what happens on an altar every day of the week. The crowd was amazed by bread that filled them until evening.`,
    turn: 'You will be handed something this week that the crowd on that hillside would have run down the hill to get. Go up for it awake — say something to him before you get back to the pew.',
    closer: 'Lord, I have stopped being surprised. Surprise me.',
  },
  {
    id: 'death-of-john-baptist',
    gospel: 'Matthew 14:1-12',
    tags: ['courage', 'charity'],
    body: `John told Herod plainly that the marriage was unlawful. It cost him his freedom, and then it cost him his head, arranged around a birthday party by a woman who could not stand being told.

Herod is the weak man in the account, not the strong one. He is afraid of the crowd, trapped by an oath he made showing off, unwilling to repent and unwilling to let go. He holds every card and does the thing he does not want to do.

On any scoreboard the world keeps, Herod won that night. But John's whole task was to say the true thing, and he said it. He said it to Herod, which is the part that gets missed: the truth-telling was aimed at saving the man who eventually killed him. That is what charity costs when it is real rather than pleasant.`,
    turn: 'There is one person you have not told the truth to, because you already know what it would cost. Work out this morning what the cost actually is, in plain numbers, rather than leaving it vague.',
    closer: 'Lord, make my charity expensive.',
  },
];

// The lectionary writes the same passage differently from year to year —
// "Matthew 14:22-33" one cycle, "Matthew 14:22-36" the next. Matching on the
// book, chapter, and opening verse is stable across all of them.
export function passageKey(ref) {
  const m = String(ref || '').match(/^\s*((?:\d\s+)?[A-Za-z][A-Za-z\s.]*?)\s+(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  const book = m[1].trim().replace(/\.$/, '').toLowerCase();
  return `${book} ${m[2]}:${m[3]}`;
}

const BY_PASSAGE = new Map(REFLECTIONS.map((r) => [passageKey(r.gospel), r]));

export function reflectionFor(gospelRef) {
  const key = passageKey(gospelRef);
  return (key && BY_PASSAGE.get(key)) || null;
}
