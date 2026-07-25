import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import CreateForm from "@/components/CreateForm";

export default async function CreatePage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/create");
  }

  return (
    <div>
      <h1>Neues Puzzle erstellen</h1>
      <CreateForm />
    </div>
  );
}
