export type GithubApp = {
  id: number;
  appName: string;
  slug?: string;
  description?: string;
};

export type GithubUser = {
  id: number;
  login: string;
};
