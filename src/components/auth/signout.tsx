"use client";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Button } from "../ui/button";

const SignOut = () => {
  const { signOut } = useAuth();
  return <Button onClick={() => signOut()}> Sign Out</Button>;
};

export default SignOut;
