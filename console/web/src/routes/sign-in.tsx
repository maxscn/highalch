import { createFileRoute } from "@tanstack/react-router";
import { SignInScreen } from "../screens/signIn.tsx";

export const Route = createFileRoute("/sign-in")({ component: SignInScreen });
