import Link from "next/link";
import { buttonVariants } from "../ui/button";

const SignIn = async () => {
  return (
    <Link
      href={"/api/auth/login"}
      className={buttonVariants({ variant: "default" })}
    >
      Sign In
    </Link>
  );
};

export default SignIn;
