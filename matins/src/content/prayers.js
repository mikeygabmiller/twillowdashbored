// Prayers are NEVER generated. This is the whole supply — traditional texts in
// their long-settled public-domain English. Add to the array, don't rewrite
// entries: `id` is what rotation state remembers.
//
// tags are used by rotation to prefer a fitting prayer for the day
// (season names in lower case, plus loose themes).

export const PRAYERS = [
  {
    id: 'our-father',
    title: 'The Our Father',
    note: 'The prayer the Lord himself taught. Say it slowly enough to mean the fourth line.',
    tags: ['daily', 'ordinary time', 'lent'],
    text: `Our Father, who art in heaven, hallowed be thy name; thy kingdom come; thy will be done on earth as it is in heaven. Give us this day our daily bread; and forgive us our trespasses as we forgive those who trespass against us; and lead us not into temptation, but deliver us from evil. Amen.`,
  },
  {
    id: 'hail-mary',
    title: 'The Hail Mary',
    note: 'Scripture and the Church, in four lines. Good for a truck cab or a stairwell.',
    tags: ['marian', 'daily'],
    text: `Hail Mary, full of grace, the Lord is with thee. Blessed art thou amongst women, and blessed is the fruit of thy womb, Jesus. Holy Mary, Mother of God, pray for us sinners, now and at the hour of our death. Amen.`,
  },
  {
    id: 'glory-be',
    title: 'The Glory Be',
    note: 'The shortest way to give God the last word on a day.',
    tags: ['daily', 'praise'],
    text: `Glory be to the Father, and to the Son, and to the Holy Spirit. As it was in the beginning, is now, and ever shall be, world without end. Amen.`,
  },
  {
    id: 'apostles-creed',
    title: "The Apostles' Creed",
    note: 'What we actually hold, said in the first person. Worth praying when belief feels thin.',
    tags: ['creed', 'easter', 'advent'],
    text: `I believe in God, the Father almighty, Creator of heaven and earth, and in Jesus Christ, his only Son, our Lord, who was conceived by the Holy Spirit, born of the Virgin Mary, suffered under Pontius Pilate, was crucified, died and was buried; he descended into hell; on the third day he rose again from the dead; he ascended into heaven, and is seated at the right hand of God the Father almighty; from there he will come to judge the living and the dead. I believe in the Holy Spirit, the holy catholic Church, the communion of saints, the forgiveness of sins, the resurrection of the body, and life everlasting. Amen.`,
  },
  {
    id: 'act-of-contrition',
    title: 'An Act of Contrition',
    note: 'The traditional form. Pray it at night; bring the grave things to confession.',
    tags: ['lent', 'penance', 'evening'],
    text: `O my God, I am heartily sorry for having offended thee, and I detest all my sins because of thy just punishments, but most of all because they offend thee, my God, who art all good and deserving of all my love. I firmly resolve, with the help of thy grace, to sin no more and to avoid the near occasions of sin. Amen.`,
  },
  {
    id: 'anima-christi',
    title: 'Anima Christi',
    note: 'Prayed after Communion for centuries. Ask for what it asks for.',
    tags: ['eucharist', 'lent'],
    text: `Soul of Christ, sanctify me. Body of Christ, save me. Blood of Christ, inebriate me. Water from the side of Christ, wash me. Passion of Christ, strengthen me. O good Jesus, hear me. Within thy wounds hide me. Suffer me not to be separated from thee. From the malignant enemy defend me. In the hour of my death call me, and bid me come unto thee, that with thy saints I may praise thee for ever and ever. Amen.`,
  },
  {
    id: 'st-michael',
    title: 'Prayer to Saint Michael the Archangel',
    note: 'Leo XIII gave this to the Church for hard ground. Short enough to say in a doorway.',
    tags: ['protection', 'ordinary time'],
    text: `Saint Michael the Archangel, defend us in battle. Be our protection against the wickedness and snares of the devil. May God rebuke him, we humbly pray; and do thou, O Prince of the heavenly host, by the power of God, thrust into hell Satan and all evil spirits who prowl about the world seeking the ruin of souls. Amen.`,
  },
  {
    id: 'memorare',
    title: 'The Memorare',
    note: 'For when you are out of your depth and know it.',
    tags: ['marian', 'trouble'],
    text: `Remember, O most gracious Virgin Mary, that never was it known that anyone who fled to thy protection, implored thy help, or sought thy intercession was left unaided. Inspired by this confidence, I fly unto thee, O Virgin of virgins, my Mother. To thee do I come, before thee I stand, sinful and sorrowful. O Mother of the Word Incarnate, despise not my petitions, but in thy mercy hear and answer me. Amen.`,
  },
  {
    id: 'angelus',
    title: 'The Angelus',
    note: 'Prayed at six, noon, and six. Keeps the Incarnation inside a working day.',
    tags: ['marian', 'advent', 'daily'],
    text: `The Angel of the Lord declared unto Mary. And she conceived of the Holy Spirit. Hail Mary…
Behold the handmaid of the Lord. Be it done unto me according to thy word. Hail Mary…
And the Word was made flesh. And dwelt among us. Hail Mary…
Pray for us, O holy Mother of God, that we may be made worthy of the promises of Christ.
Pour forth, we beseech thee, O Lord, thy grace into our hearts, that we to whom the Incarnation of Christ thy Son was made known by the message of an angel, may by his Passion and Cross be brought to the glory of his Resurrection. Through the same Christ our Lord. Amen.`,
  },
  {
    id: 'come-holy-spirit',
    title: 'Come, Holy Spirit',
    note: 'Before work you do not feel equal to.',
    tags: ['pentecost', 'easter', 'work'],
    text: `Come, Holy Spirit, fill the hearts of thy faithful and kindle in them the fire of thy love. Send forth thy Spirit and they shall be created, and thou shalt renew the face of the earth.
O God, who by the light of the Holy Spirit didst instruct the hearts of the faithful, grant that by the same Holy Spirit we may be truly wise and ever rejoice in his consolation. Through Christ our Lord. Amen.`,
  },
  {
    id: 'salve-regina',
    title: 'Hail, Holy Queen',
    note: 'The Church sings this at the end of the day and at the end of a life.',
    tags: ['marian', 'evening'],
    text: `Hail, holy Queen, Mother of mercy, our life, our sweetness, and our hope. To thee do we cry, poor banished children of Eve. To thee do we send up our sighs, mourning and weeping in this valley of tears. Turn then, most gracious advocate, thine eyes of mercy toward us, and after this our exile show unto us the blessed fruit of thy womb, Jesus. O clement, O loving, O sweet Virgin Mary. Amen.`,
  },
  {
    id: 'suscipe',
    title: 'The Suscipe of Saint Ignatius',
    note: 'Do not pray it distractedly. It asks for everything and means it.',
    tags: ['surrender', 'ordinary time'],
    text: `Take, Lord, and receive all my liberty, my memory, my understanding, and my entire will — all that I have and possess. Thou hast given all to me; to thee, O Lord, I return it. All is thine; dispose of it wholly according to thy will. Give me thy love and thy grace, for this is enough for me. Amen.`,
  },
  {
    id: 'sub-tuum',
    title: 'We Fly to Thy Patronage',
    note: 'The oldest known prayer to Our Lady. Christians were saying this in the third century.',
    tags: ['marian', 'protection'],
    text: `We fly to thy patronage, O holy Mother of God; despise not our petitions in our necessities, but deliver us always from all dangers, O glorious and blessed Virgin. Amen.`,
  },
  {
    id: 'guardian-angel',
    title: 'Prayer to My Guardian Angel',
    note: 'A child’s prayer that grown men should keep saying, especially on the road.',
    tags: ['daily', 'protection', 'morning'],
    text: `Angel of God, my guardian dear, to whom God's love commits me here, ever this day be at my side, to light and guard, to rule and guide. Amen.`,
  },
  {
    id: 'aquinas-before-work',
    title: 'Saint Thomas Aquinas — Before Work',
    note: 'Aquinas prayed before he wrote. Pray it before you open the truck door.',
    tags: ['work', 'morning', 'ordinary time'],
    text: `Grant me, O Lord my God, a mind to know thee, a heart to seek thee, wisdom to find thee, conduct pleasing to thee, faithful perseverance in waiting for thee, and a hope of finally embracing thee. Give me a right way of beginning, a right way of going on, and a right way of finishing. Amen.`,
  },
];

export const PRAYER_BY_ID = Object.fromEntries(PRAYERS.map((p) => [p.id, p]));
