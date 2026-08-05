/**
 * Fixtures for the morning-digest tests.
 *
 * Reddit, Google News and Open-Meteo are all unreachable from CI (and from the
 * sandbox this was built in), so the pipeline is exercised against captured
 * shapes instead. These are real formats, not simplified ones: entity-escaped
 * HTML inside Atom <content>, CDATA in RSS, the whole point being that the regex
 * feed parser is tested on what it will actually be handed.
 */

export function atomFeed(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <category term="AutoDetailing" label="r/AutoDetailing"/>
  <updated>2026-08-04T12:00:00+00:00</updated>
  <title>Top posts</title>
${entries.map((e) => `  <entry>
    <author><name>/u/${e.author || 'someone'}</name></author>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;${escapeXml(e.body || '')}&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>
    <id>${e.id}</id>
    <link href="${e.url}"/>
    <updated>${e.updated || '2026-08-04T09:12:00+00:00'}</updated>
    <title>${escapeXml(e.title)}</title>
  </entry>`).join('\n')}
</feed>`;
}

export function rss2Feed(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>
${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.url}</link>
<guid isPermaLink="false">${i.id}</guid><pubDate>Mon, 04 Aug 2026 14:02:00 GMT</pubDate>
<description><![CDATA[<a href="${i.url}">${i.body}</a>]]></description><source url="https://example.com">Example</source></item>`).join('\n')}
</channel></rss>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Every price and model number in these bodies is what the verbatim guard checks
// the model's write-up against, so they matter as much as the prose.
export const POSTS = {
  AutoDetailing: [
    { id: 't3_aa1', title: 'CarPro CQuartz UK 3.0 dropped to $79 at Detailed Image', url: 'https://www.reddit.com/r/AutoDetailing/comments/aa1/cquartz/',
      body: 'CQuartz UK 3.0 is $79 for the 50ml kit right now, down from $109. Code lasts through Sunday. I have run this coating for two seasons in the PNW and it still beads at 18 months.' },
    { id: 't3_aa2', title: 'Two-bucket vs rinseless: 40 washes later', url: 'https://www.reddit.com/r/AutoDetailing/comments/aa2/rinseless/',
      body: 'Did 40 washes split between two-bucket and rinseless on the same black Accord. Under 500 lumens of inspection light the rinseless panels had noticeably more marring at the 20 wash mark.' },
    { id: 't3_aa3', title: 'Griots BOSS 15mm on sale, worth it over the 21mm?', url: 'https://www.reddit.com/r/AutoDetailing/comments/aa3/boss/',
      body: 'The G15 is $199 this week. Coming from a 21mm I find the 15mm easier on tight panels but slower on hoods.' },
  ],
  harborfreight: [
    { id: 't3_hf1', title: 'Icon 1/2 in impact is 25% off with the September coupon', url: 'https://www.reddit.com/r/harborfreight/comments/hf1/icon/',
      body: 'Icon 1/2 in impact wrench is 25% off, bringing it to $149. Coupon ends Sunday. It pulls 1000 ft-lb nut busting which is plenty for lug nuts.' },
    { id: 't3_hf2', title: 'Bauer 20V vacuum long term review', url: 'https://www.reddit.com/r/harborfreight/comments/hf2/bauer/',
      body: 'Two years on the Bauer 20V wet dry vac. Filter clogs fast with pet hair but for $59 it has outlived two shop vacs.' },
  ],
  ClaudeAI: [
    { id: 't3_cl1', title: 'Usage limits changed again on the $20 plan', url: 'https://www.reddit.com/r/ClaudeAI/comments/cl1/limits/',
      body: 'The $20 plan messaging cap moved. People are reporting hitting it after roughly 45 messages in a 5 hour window.' },
  ],
  Snohomish: [
    { id: 't3_sn1', title: 'US-2 trestle closure this weekend', url: 'https://www.reddit.com/r/Snohomish/comments/sn1/trestle/',
      body: 'The westbound trestle is closed Saturday 6am to 2pm for paving. Expect Everett traffic to be miserable.' },
  ],
};

export const COMMENTS = {
  't3_aa1': [
    'I bought at $79 last spring and it hit $69 in March, so this is not the floor. Wait for the holiday sale if you can.',
    'The 50ml kit covers about two mid-size cars if your prep is tight. Do not try to stretch it over three.',
  ],
  't3_hf1': [
    'Mine has been fine for lug nuts but it stalls on rusted suspension bolts. For $149 it is still the best value in the store.',
    'Coupon is in the September flyer, and it does stack with the member pricing.',
  ],
  't3_aa2': ['Rinseless is fine if the car is not filthy. On a work truck it is a scratch machine.'],
};

export const NEWS = [
  { id: 'n1', title: 'Snohomish County fair week brings road closures', url: 'https://example.com/fair', body: 'The county fair runs all week with closures around the fairgrounds.' },
  { id: 'n2', title: 'New detailing shop opens in Everett charging $250 for full details', url: 'https://example.com/shop', body: 'A new shop opened on Evergreen Way advertising full details at $250.' },
];

export function weatherJson(dates) {
  const hours = [];
  const hourly = { time: [], precipitation_probability: [], temperature_2m: [], wind_speed_10m: [], cloud_cover: [] };
  for (const d of dates) {
    for (let h = 0; h < 24; h++) {
      const t = `${d}T${String(h).padStart(2, '0')}:00`;
      hourly.time.push(t);
      // Afternoon downpour on the second day — that's the case the scheduling
      // advice has to catch.
      const rain = (d === dates[1] && h >= 13 && h <= 17) ? 82 : 12;
      hourly.precipitation_probability.push(rain);
      hourly.temperature_2m.push(h < 8 ? 52 : 66);
      hourly.wind_speed_10m.push(7);
      hourly.cloud_cover.push(40);
      hours.push(t);
    }
  }
  return JSON.stringify({
    daily: {
      time: dates,
      precipitation_probability_max: dates.map((d, i) => (i === 1 ? 82 : 15)),
      precipitation_sum: dates.map((d, i) => (i === 1 ? 0.31 : 0)),
      temperature_2m_max: dates.map(() => 71),
      temperature_2m_min: dates.map(() => 51),
      wind_speed_10m_max: dates.map(() => 11),
      uv_index_max: dates.map(() => 5),
    },
    hourly,
  });
}

export function airJson(dates) {
  const time = [], us_aqi = [], pm2_5 = [];
  for (const d of dates) for (let h = 0; h < 24; h++) { time.push(`${d}T${String(h).padStart(2, '0')}:00`); us_aqi.push(38); pm2_5.push(6.2); }
  return JSON.stringify({ hourly: { time, us_aqi, pm2_5 } });
}
