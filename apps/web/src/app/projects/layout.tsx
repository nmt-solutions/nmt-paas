import React, { PropsWithChildren } from "react";

const ProjectsLayout = ({ children }: PropsWithChildren) => {
  return <div className="w-full max-w-3xl mx-auto">{children}</div>;
};

export default ProjectsLayout;
