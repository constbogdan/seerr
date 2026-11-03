// 0/0 is the existing Series-wide sentinel; 0/E is a specific Special.
export function hasIssueSeason(issue: {
  problemSeason: number;
  problemEpisode: number;
}): boolean {
  return issue.problemSeason > 0 || issue.problemEpisode > 0;
}
