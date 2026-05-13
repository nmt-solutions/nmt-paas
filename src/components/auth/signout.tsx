"use client";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useTRPC } from "@/trpc/client";
import { Button } from "../ui/button";

const SignOut = () => {
  const { signOut } = useAuth();

  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.user.getUsers.queryOptions({
      after: "",
      before: "",
      email: "",
      limit: 10,
    }),
  );

  console.log(data);

  return <Button onClick={() => signOut()}> Sign Out</Button>;
};

export default SignOut;
