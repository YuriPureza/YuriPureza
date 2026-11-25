import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const login = 'YuriPureza';
const weekCount = 30;
const dayMs = 86_400_000;
const now = new Date();
const today = new Date(now.toISOString().slice(0, 10));
const first = new Date(today.getTime() - ((weekCount - 1) * 7 + today.getUTCDay()) * dayMs);
const date = value => value.toISOString().slice(0, 10);
const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    login
    contributionsCollection(from: $from, to: $to) {
      restrictedContributionsCount
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      totalRepositoriesWithContributedCommits
      totalRepositoriesWithContributedIssues
      totalRepositoriesWithContributedPullRequests
      totalRepositoriesWithContributedPullRequestReviews
      commitContributionsByRepository(maxRepositories: 100) { repository { visibility } }
      issueContributionsByRepository(maxRepositories: 100) { repository { visibility } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { visibility } }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { visibility } }
      repositoryContributions(first: 100) {
        nodes { repository { visibility } }
      }
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { date weekday contributionCount }
        }
      }
    }
  }
}`;

function verifyPublicCalendar(collection) {
  const groups = [
    [collection.commitContributionsByRepository, collection.totalRepositoriesWithContributedCommits],
    [collection.issueContributionsByRepository, collection.totalRepositoriesWithContributedIssues],
    [collection.pullRequestContributionsByRepository, collection.totalRepositoriesWithContributedPullRequests],
    [collection.pullRequestReviewContributionsByRepository, collection.totalRepositoriesWithContributedPullRequestReviews],
    [collection.repositoryContributions?.nodes, collection.totalRepositoryContributions],
  ];
  const totals = [
    collection.totalCommitContributions,
    collection.totalIssueContributions,
    collection.totalPullRequestContributions,
    collection.totalPullRequestReviewContributions,
    collection.totalRepositoryContributions,
  ];

  if (collection.restrictedContributionsCount !== 0 ||
      !totals.every(total => Number.isSafeInteger(total) && total >= 0) ||
      totals.reduce((sum, total) => sum + total, 0) !== collection.contributionCalendar.totalContributions ||
      !groups.every(([records, expected]) => Array.isArray(records) && records.length === expected &&
        records.every(record => record?.repository?.visibility === 'PUBLIC'))) {
    throw new Error('The calendar could not be verified as exclusively public.');
  }
}

function getCalendar() {
  let raw;
  try {
    raw = execFileSync('gh', [
      'api', 'graphql', '--hostname', 'github.com',
      '-f', `query=${query}`,
      '-f', `login=${login}`,
      '-f', `from=${first.toISOString()}`,
      '-f', `to=${now.toISOString()}`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, GH_DEBUG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    throw new Error('The GitHub GraphQL request failed. Check API availability and token access.');
  }

  let response;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error('GitHub GraphQL returned invalid JSON.');
  }
  const account = response?.data?.user;
  const collection = account?.contributionsCollection;
  const calendar = collection?.contributionCalendar;
  if (response?.errors?.length || account?.login !== login || !Array.isArray(calendar?.weeks)) {
    throw new Error('GitHub did not return the requested contribution calendar.');
  }
  verifyPublicCalendar(collection);

  const days = new Map();
  for (const day of calendar.weeks.flatMap(week => week.contributionDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        !Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0 ||
        new Date(day.date).getUTCDay() !== day.weekday || days.has(day.date)) {
      throw new Error('The GitHub calendar contains an invalid or duplicate day.');
    }
    days.set(day.date, day.contributionCount);
  }

  const length = (today - first) / dayMs + 1;
  const counts = Array.from({ length }, (_, index) =>
    days.get(date(new Date(first.getTime() + index * dayMs))));
  if (counts.includes(undefined) || counts.reduce((sum, count) => sum + count, 0) !== calendar.totalContributions) {
    throw new Error('The returned days do not match the requested range and total.');
  }
  return { counts, total: calendar.totalContributions };
}

const levels = [
  { minimum: 0, color: '#142533' },
  { minimum: 1, color: '#12617A' },
  { minimum: 2, color: '#008CAC' },
  { minimum: 4, color: '#00AED6' },
  { minimum: 8, color: '#00C8FF' },
];

function drawCalendar(counts, total) {
  const end = date(today);
  const start = date(first);
  const cells = counts.map((count, index) => {
    const x = 20 + Math.floor(index / 7) * 22.4;
    const y = 45 + (index % 7) * 13;
    const day = date(new Date(first.getTime() + index * dayMs));
    const { color } = levels.findLast(level => count >= level.minimum);
    return `    <rect x="${x.toFixed(1)}" y="${y}" width="18" height="10" rx="2" fill="${color}" data-date="${day}" data-count="${count}"><title>${day}: ${count}</title></rect>`;
  }).join('\n');
  const legend = levels.map(({ color }, index) =>
    `    <rect x="${533 + index * 15}" y="140" width="11" height="9" rx="2" fill="${color}"/>`).join('\n');
  const label = total === 1 ? 'contribution' : 'contributions';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="712" height="164" viewBox="0 0 712 164" role="img" aria-labelledby="title desc">
  <title id="title">GitHub contribution telemetry</title>
  <desc id="desc">${total} ${label} reported by the GitHub GraphQL API for ${login}, ${start} to ${end} UTC. Columns are weeks, with Sunday through Saturday from top to bottom. Brighter squares show more contributions. Future days are left blank.</desc>
  <style>
    @media (max-width: 560px) {
      .chart-caption { font-size: 22px; }
      .chart-total { font-size: 23px; }
      .chart-detail { font-size: 18px; }
    }
  </style>
  <rect x=".5" y=".5" width="711" height="163" rx="6" fill="#0C1824" stroke="#164052"/>
  <text class="chart-caption" x="20" y="27" fill="#00C8FF" font-family="monospace" font-size="16">GITHUB // CONTRIBUTION TELEMETRY</text>
  <text class="chart-total" x="692" y="27" fill="#E6F4FF" font-family="system-ui, sans-serif" font-size="17" font-weight="700" text-anchor="end">${total} ${label}</text>
  <g aria-hidden="true">
${cells}
  </g>
  <g class="chart-detail" fill="#A9C4D8" font-family="system-ui, sans-serif" font-size="13" aria-hidden="true">
    <text x="20" y="149">${start} &#8212; ${end} UTC</text>
    <text x="485" y="149">Less</text>
${legend}
    <text x="611" y="149">More</text>
  </g>
</svg>
`;
}

try {
  const { counts, total } = getCalendar();
  const output = fileURLToPath(new URL('../assets/jarvis/analytics.svg', import.meta.url));
  const rendered = drawCalendar(counts, total);
  let current;
  try {
    current = readFileSync(output, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === rendered) {
    console.log('Analytics is already current.');
  } else {
    const pending = `${output}.${process.pid}.tmp`;
    writeFileSync(pending, rendered, { encoding: 'utf8', flag: 'wx' });
    try {
      renameSync(pending, output);
    } finally {
      rmSync(pending, { force: true });
    }
    console.log(`Updated analytics.svg with ${total} contributions across ${counts.length} days (${date(first)} to ${date(today)} UTC).`);
  }
} catch (error) {
  console.error(`Analytics update failed: ${error.message}`);
  process.exitCode = 1;
}
