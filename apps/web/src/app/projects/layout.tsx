import React, { PropsWithChildren } from "react";

const ProjectsLayout = ({ children }: PropsWithChildren) => {
  return <div className="mx-auto w-full max-w-7xl">{children}</div>;
};

export default ProjectsLayout;
