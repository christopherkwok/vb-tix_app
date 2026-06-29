export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(
      'https://api.github.com/repos/christopherkwok/vb-tix_app/actions/workflows/scrape.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vb-tix-cron-worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    console.log(`GitHub dispatch: ${res.status}`);
  },
};
