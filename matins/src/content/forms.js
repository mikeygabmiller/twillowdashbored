// REFLECTION FORMS — the shape of the day's reflection, rotated like the
// prayers are.
//
// Why this exists: "write 4 to 6 sentences of reflection" is a length, not a
// shape, and a model given only a length writes the same paragraph every day —
// observation, gentle pivot, uplift. Naming the shape, and changing which
// shape is asked for, is the single biggest lever on variety. Rotation is
// deterministic by date (lib/rotation.js), so a preview shows what that date
// would really get.
//
// Each form carries one EXEMPLAR: a worked example in the house voice, about a
// day other than today. Few-shot is what holds the register steady; the model
// imitates the exemplar's texture without being able to copy its content.
//
// THE EXEMPLARS ARE THE PRODUCT. If the writing drifts, fix them here before
// touching anything in lib/. Every one obeys the hard rules — in particular,
// none of them narrates the content of a reading. See README, "Stories".

export const FORMS = [
  {
    id: 'objection',
    name: 'The objection',
    tags: ['ordinary time', 'daily'],
    brief:
      'Open with the reasonable objection the reader would raise — the honest "what has this got to do with me" — stated fairly and without irony. Then answer it, without pretending the objection was stupid.',
    exemplar: `You could be forgiven for thinking a fourth-century martyr has nothing to say to a man with a mortgage. Dying for the faith is not on today's list. But the thing that got him killed was not a grand moment; it was a small refusal, repeated, until somebody important noticed. You will get the same chance around ten this morning, when it would be easier to agree with something you do not believe. Nobody is going to kill you for it. That is not the same as it costing nothing.`,
  },
  {
    id: 'scene',
    name: 'One scene',
    tags: ['ordinary time', 'daily', 'work'],
    brief:
      'Open inside one specific ordinary moment — a place, a time of day, a physical detail — told in the second person. Stay in it for two or three sentences before you turn to the day. The turn should feel like noticing, not like a lesson beginning.',
    exemplar: `There is a particular kind of tired that arrives at the end of a shift when the last job went badly and you still have to drive home. You are not angry yet. You are empty, and you know the anger is coming somewhere around the second stoplight. The Church puts this feast in front of people who are mostly in exactly that state, and it does not tell them to cheer up. It tells them what they are for. Being spent and being needed are not evidence that something has gone wrong.`,
  },
  {
    id: 'hard-saying',
    name: 'The hard saying',
    tags: ['lent', 'advent', 'daily'],
    brief:
      'Name the uncomfortable thing in today plainly, and refuse to soften it. Do not resolve it into reassurance. The reader is not fragile and knows when they are being handled.',
    exemplar: `Today's Gospel is one people quietly skip. It talks about counting the cost before you start, and it means it. We would rather hear that God takes us as we are, which is true, and then stop there, which is not. The Church has never pretended the following part is cheap, and every saint on the calendar paid for it in public. If you have been putting off one honest conversation because you already know what it will cost you, that is the one.`,
  },
  {
    id: 'plain-fact',
    name: 'The plain fact',
    tags: ['ordinary time', 'daily'],
    brief:
      'Open with a flat, unadorned statement of fact about the day, the season, or the rank of the celebration — the sort of thing that sounds like nothing. Then show why it is not nothing. No build-up, no adjectives in the first sentence.',
    exemplar: `This is the seventeenth week of Ordinary Time, which is not a phrase designed to stir anybody. Most of the Church year is like this: green, unremarkable, no obligation attached. It is also where nearly all of a life actually gets lived. The saints did not become saints on the feast days. They became saints in the long green weeks, doing the same work badly and then slightly less badly.`,
  },
  {
    id: 'long-middle',
    name: 'The long middle',
    tags: ['ordinary time', 'work'],
    brief:
      'For the unglamorous stretch. The subject is persistence without feeling — year four of a job, year eleven of a marriage, the hundredth time at the same Mass. Do not promise it gets easier.',
    exemplar: `Nobody warns you that the hard part of a job is not the start. The start is easy; you are new and everything is still interesting. The hard part is year four, when you know exactly how it goes and you have to do it anyway. That is most of what fidelity means, in a trade or a marriage or the faith, and it is why the Church keeps ordinary weekdays at all. Showing up today counts for more than it will feel like it does.`,
  },
  {
    id: 'cost',
    name: 'The cost',
    tags: ['lent', 'advent', 'feast', 'daily'],
    brief:
      'Point at the version of today that costs the reader nothing, name it accurately, and then say what the day is actually asking. End by making them choose the expensive one. This is the one form permitted to be slightly confrontational.',
    exemplar: `There is a version of today's feast that costs nothing. You read about it, you feel briefly warmer, you go to work. The Church is not offering that version. Keeping a day means letting it interrupt something — five minutes you would rather spend on your phone, or an apology you have been rehearsing for a week without delivering. One of those is genuinely more expensive than the other. Pick that one.`,
  },
];

export const FORM_BY_ID = Object.fromEntries(FORMS.map((f) => [f.id, f]));

// The saint block is narrative, so it gets an exemplar of its own rather than a
// rotating set. Note what it does NOT do: no invented dates, no invented
// places, no quotations, no legend told as fact. It builds a scene out of the
// shape of a life, which is all the fact sheet can support today.
export const SAINT_EXEMPLAR = {
  life: `He was a bishop during a stretch when being a bishop meant being available to people who had lost everything, and there is no record that he ever tried to get out of it. The office was not a promotion. It was a rota of funerals, arguments about money, and other people's disasters arriving at his door in no particular order.

What is worth knowing is that he kept doing it into old age, after the interesting part was over and the admiration had worn off. That is the part nobody paints.`,
  oneActionToday: `Answer the message from the person you have been putting off — the one whose problem you cannot fix — before you eat tonight.`,
};

// Headlines drift into slogans faster than anything else in the issue, so they
// get exemplars too. All lower case, no colon, nothing that could be a poster.
export const HEADLINE_EXEMPLARS = [
  'the part nobody paints',
  'year four is the hard one',
  'a small refusal, repeated',
  'what the day is actually asking',
  'the long green weeks',
  'you are not angry yet',
];
