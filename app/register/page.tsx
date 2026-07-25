import Link from "next/link";
import { isRegistrationEnabled } from "@/lib/registration";
import RegisterForm from "@/components/RegisterForm";

export default function RegisterPage() {
  if (!isRegistrationEnabled()) {
    return (
      <div className="form card">
        <h1>Registrierung deaktiviert</h1>
        <p className="muted">
          Die öffentliche Registrierung ist derzeit deaktiviert. Konten können nur per
          Einladung angelegt werden.
        </p>
        <p className="muted">
          <Link href="/login">Zur Anmeldung</Link>
        </p>
      </div>
    );
  }

  return <RegisterForm />;
}
