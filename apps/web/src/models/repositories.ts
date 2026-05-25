export type Repository = {
  id: number;
  defaultBranch: string;
  name: string;
  owner: {
    id: number;
    name: string;
  };
  private: boolean;
  slug: string;
  updatedAt: number;
  url: string;
};
