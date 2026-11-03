import type { SubtitleItem } from '@server/lib/subtitleIssue';
import { SubtitleReportError } from '@server/lib/subtitleIssue';
import axios from 'axios';

// Separate from the general provider client: never log axios errors/configs,
// forward credentials on redirects, use a provider cache or persist this token.
export class SubtitleJellyfin {
  private readonly client;

  constructor(baseUrl: string, token: string) {
    this.client = axios.create({
      baseURL: `${baseUrl.replace(/\/$/, '')}/`,
      headers: { 'X-Emby-Token': token },
      timeout: 5000,
      maxRedirects: 0,
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024,
    });
  }

  private async get<T>(path: string): Promise<T> {
    try {
      return (await this.client.get<T>(path)).data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 401 || status === 403) {
        throw new SubtitleReportError(
          401,
          'Jellyfin authentication or item access was rejected.'
        );
      }
      if (status === 404)
        throw new SubtitleReportError(404, 'Jellyfin item was not found.');
      throw new SubtitleReportError(
        502,
        'Jellyfin could not verify this report.'
      );
    }
  }

  getUser() {
    return this.get<{ Id?: string; Policy?: { IsDisabled?: boolean } }>(
      'Users/Me'
    );
  }

  getItem(userId: string, itemId: string) {
    return this.get<SubtitleItem>(`Users/${userId}/Items/${itemId}`);
  }
}
