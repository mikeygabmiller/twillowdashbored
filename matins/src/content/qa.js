// "Consider" — pre-written, pre-vetted Q&A. These skip the safety pass because
// they are written and reviewed by a human, not generated. Nothing here is
// produced at runtime.
//
// Citations name a source; they never reproduce its text (see README on
// copyright). Keep answers short, accurate, and careful about the difference
// between what the Church binds and what is opinion or custom.
// Seeded at 20; the target is ~100. Append, don't renumber — `id` is what
// rotation remembers.

export const QA_BANK = [
  {
    id: 'qa-mass-obligation',
    question: 'Why do Catholics have to go to Mass on Sunday?',
    answer:
      'Sunday is the day of the Resurrection, and the Church asks Catholics to keep it by taking part in Mass on Sunday or Saturday evening, together with the holy days of obligation. It is a real obligation, binding those who can meet it. Deliberately skipping Mass without a serious reason is grave matter.',
    citation: 'Catechism of the Catholic Church, 2177–2181',
    tags: ['mass', 'practice'],
  },
  {
    id: 'qa-missed-mass-reason',
    question: 'I had to work Sunday. Did I sin?',
    answer:
      'No. Illness, the care of infants, and work that genuinely cannot be moved excuse a person from the Sunday obligation. If you can get to a Saturday vigil or a different Mass time, take it; if you truly cannot, keep the day holy some other way and do not carry a false guilt. Your pastor can dispense you if the conflict is ongoing.',
    citation: 'Catechism of the Catholic Church, 2181',
    tags: ['mass', 'work', 'conscience'],
  },
  {
    id: 'qa-mortal-sin',
    question: 'What makes a sin mortal rather than venial?',
    answer:
      'Three things together: the matter is grave, you know it is grave, and you choose it freely anyway. Take away any one of the three and the sin is not mortal, though it is still a real wound. This is why fear, ignorance, habit, and compulsion genuinely lessen guilt — and why they are worth naming honestly in confession rather than guessing.',
    citation: 'Catechism of the Catholic Church, 1857–1859',
    tags: ['sin', 'confession'],
  },
  {
    id: 'qa-confess-to-priest',
    question: 'Why confess to a priest instead of straight to God?',
    answer:
      'Because Christ gave the apostles authority to forgive sins in his name, and that authority is exercised in the sacrament. You are confessing to God — the priest is where God has promised to meet you with words you can actually hear. The absolution is his, spoken through a man who is bound never to repeat what you said.',
    citation: 'Catechism of the Catholic Church, 1441–1467',
    tags: ['confession', 'sacraments'],
  },
  {
    id: 'qa-confession-frequency',
    question: 'How often do I actually have to go to confession?',
    answer:
      'Grave sin must be confessed before receiving Communion, and the Church asks every Catholic to confess serious sins at least once a year. Confessing venial sins is not required, but the Church strongly commends it: it forms the conscience and hands the same weaknesses over to grace again and again. Once a month is a sane rhythm for most people.',
    citation: 'Catechism of the Catholic Church, 1457–1458',
    tags: ['confession', 'practice'],
  },
  {
    id: 'qa-eucharist-real',
    question: 'Is the Eucharist really Jesus, or a symbol?',
    answer:
      'Really Jesus — body, blood, soul, and divinity, under the appearances of bread and wine. The Church calls the change transubstantiation: what the thing is changes, while everything you can see, taste, and measure stays the same. This is not a pious opinion but the settled faith of the Church.',
    citation: 'Catechism of the Catholic Church, 1373–1377',
    tags: ['eucharist', 'doctrine'],
  },
  {
    id: 'qa-communion-state-of-grace',
    question: 'Can I receive Communion if I am aware of a mortal sin?',
    answer:
      'Not until you have been to confession. Receiving in that state does further harm rather than good. If you find yourself at Mass in that position, stay in the pew, make an act of contrition, and go to confession as soon as you can — nobody is watching you as closely as you think.',
    citation: 'Catechism of the Catholic Church, 1385',
    tags: ['eucharist', 'confession'],
  },
  {
    id: 'qa-pray-to-saints',
    question: 'Why pray to saints instead of to God?',
    answer:
      'Asking a saint to pray for you is the same thing as asking a friend to pray for you, except that this friend is already with God. It is intercession, not worship — worship belongs to God alone. The saints do not compete with Christ; they are the proof of what he does with a life.',
    citation: 'Catechism of the Catholic Church, 956, 2683',
    tags: ['saints', 'prayer'],
  },
  {
    id: 'qa-mary-worship',
    question: 'Do Catholics worship Mary?',
    answer:
      'No. Adoration is given to God alone; Mary receives honour, of a higher degree than any other saint but different in kind from what belongs to God. Every Marian devotion the Church has ever approved points at her Son — that is the test of whether it is being used rightly.',
    citation: 'Catechism of the Catholic Church, 971, 2110–2114',
    tags: ['mary', 'doctrine'],
  },
  {
    id: 'qa-immaculate-conception',
    question: 'What is the Immaculate Conception?',
    answer:
      "It is Mary's own conception, not Jesus'. The Church holds that from the first instant of her existence Mary was preserved from original sin, by the grace of the very Redeemer she would bear. Pius IX defined it in 1854 — a dogma, not an opinion.",
    citation: 'Catechism of the Catholic Church, 490–493',
    tags: ['mary', 'doctrine'],
  },
  {
    id: 'qa-purgatory',
    question: 'What is purgatory?',
    answer:
      'The final purification of those who die in God\'s friendship but are not yet wholly free of the effects of sin. Everyone in purgatory is saved — this is not a second chance and not a lesser hell. It is why the Church prays for the dead, and why that prayer is worth doing.',
    citation: 'Catechism of the Catholic Church, 1030–1032',
    tags: ['last things', 'doctrine'],
  },
  {
    id: 'qa-fasting-rules',
    question: 'What is the Church actually asking of me on a Friday?',
    answer:
      'Catholics are asked to do penance on every Friday of the year; in Lent, that means abstaining from meat, and Ash Wednesday and Good Friday are days of both fasting and abstinence. Outside Lent, in the United States, another penance may be substituted for abstaining from meat — but something is meant to be done. Age and health exempt you; nobody is asked to injure themselves.',
    citation: 'Catechism of the Catholic Church, 1249–1253, 2043',
    tags: ['lent', 'practice'],
  },
  {
    id: 'qa-non-catholic-communion',
    question: 'Can my Protestant friend receive Communion at a Catholic Mass?',
    answer:
      'Ordinarily no, and it is not a snub. Receiving Communion states that you are in full communion with the Catholic Church and hold what she holds about the Eucharist. Your friend is genuinely welcome at Mass and can come forward for a blessing.',
    citation: 'Catechism of the Catholic Church, 1398–1401',
    tags: ['eucharist', 'practice'],
  },
  {
    id: 'qa-private-revelation',
    question: 'Do I have to believe in Fatima or Lourdes?',
    answer:
      'No. Public revelation closed with the apostles; approved apparitions add nothing to it. When the Church approves one she is saying it contains nothing contrary to the faith and may help devotion — Catholics are free to take it up or leave it alone.',
    citation: 'Catechism of the Catholic Church, 66–67',
    tags: ['doctrine', 'devotion'],
  },
  {
    id: 'qa-rosary-point',
    question: 'What is the point of the rosary if I keep getting distracted?',
    answer:
      'The rosary is meditation on the life of Christ with his mother, carried by repetition that is meant to occupy the surface of the mind. Distraction is not failure; noticing it and beginning again is the prayer. Ten minutes prayed badly is worth more than the perfect rosary you did not say.',
    citation: null,
    tags: ['prayer', 'mary'],
  },
  {
    id: 'qa-feel-nothing',
    question: 'I feel nothing at Mass. Is something wrong with me?',
    answer:
      'Probably not. The Mass is Christ\'s action, and what it gives does not depend on your emotional weather that morning. Consolation is a gift, not a wage; long stretches without it are ordinary in the lives of the saints. Keep showing up, and tell a confessor or a good priest if the dryness is crushing you.',
    citation: null,
    tags: ['prayer', 'mass'],
  },
  {
    id: 'qa-scruples',
    question: 'I confess the same thing constantly and still feel guilty. Is that holiness?',
    answer:
      'No, and it is worth saying plainly: scrupulosity is a burden, not a virtue. Absolution is real whether or not you feel absolved. Pick one confessor, tell him what is happening, and then obey what he tells you rather than re-litigating it alone.',
    citation: null,
    tags: ['confession', 'conscience'],
  },
  {
    id: 'qa-work-dignity',
    question: 'Does my job matter to God, or only what I do at church?',
    answer:
      'It matters. Human work shares in the work of the Creator and is one of the ordinary ways a person is sanctified — the Church teaches this directly. Honest craftsmanship, fair dealing, and patience with the people you work beside are not preliminaries to the spiritual life; on most days they are it.',
    citation: 'Catechism of the Catholic Church, 2427–2428',
    tags: ['work', 'vocation'],
  },
  {
    id: 'qa-grace',
    question: 'What do Catholics mean by grace?',
    answer:
      'Grace is God\'s own life given freely — not a reward you earn and not a feeling. It heals what sin has damaged and makes a person able to act as a child of God. Because it is free, the right response is not anxiety about deserving it but gratitude and use.',
    citation: 'Catechism of the Catholic Church, 1996–1999',
    tags: ['doctrine', 'grace'],
  },
  {
    id: 'qa-canon-73',
    question: 'Why does a Catholic Bible have more books?',
    answer:
      'The Catholic canon has 73 books; most Protestant Bibles have 66. The seven the Church keeps were in the Greek Old Testament used by the early Church and were listed in Catholic canons from the fourth century on. They were dropped at the Reformation, not added at Trent — Trent restated what the Church already used.',
    citation: 'Catechism of the Catholic Church, 120',
    tags: ['scripture', 'doctrine'],
  },
];

export const QA_BY_ID = Object.fromEntries(QA_BANK.map((q) => [q.id, q]));
