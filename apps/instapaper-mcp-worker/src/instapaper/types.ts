export interface InstapaperCredentials {
  consumerKey: string;
  consumerSecret: string;
  oauthToken: string;
  oauthTokenSecret: string;
}

export interface InstapaperUser {
  user_id?: number;
  username?: string;
  subscription_is_active?: string;
}

export interface Bookmark {
  bookmark_id: number;
  url: string;
  title: string;
  description?: string;
  time?: number;
  starred?: string;
  folder_id?: number;
  folder?: string;
  hash?: string;
  progress?: number;
  progress_timestamp?: number;
  private_source?: string;
}

export interface Folder {
  folder_id: number;
  title: string;
  position?: number;
}

export interface Highlight {
  highlight_id: number;
  bookmark_id?: number;
  text: string;
  position?: number;
  time?: number;
}

export interface BookmarkListResponse {
  user?: InstapaperUser;
  bookmarks: Bookmark[];
  highlights?: Highlight[];
  delete_ids?: number[];
}

export interface XAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  username: string;
  password?: string;
}

export interface OAuthTokens {
  token: string;
  tokenSecret: string;
}
