import { Resend } from 'resend';
import { emailEnabled, env } from '../../env';
import {
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
  welcomeEmail,
  type RenderedEmail,
} from './templates';

/**
 * Camada de e-mail transacional. Provider único hoje (Resend), isolado atrás de
 * `sendEmail` — trocar de provider (SES, Postmark...) é reimplementar só esta
 * função. As funções `sendXEmail` montam o template e disparam; o resto do app
 * só conhece estas.
 *
 * O envio é OPCIONAL: sem `RESEND_API_KEY`, `sendEmail` apenas loga e retorna —
 * nenhum fluxo quebra por falta de e-mail.
 */

let resend: Resend | null = null;

/** Cliente Resend lazy — só instanciado quando há chave configurada. */
function getResend(): Resend {
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Envia um e-mail. Lança em caso de falha — quem chama decide se é fatal. */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!emailEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      `[email] envio desativado (RESEND_API_KEY ausente) — pulando "${input.subject}" para ${input.to}`,
    );
    return;
  }
  const { error } = await getResend().emails.send({
    from: env.RESEND_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  if (error) {
    throw new Error(`Falha ao enviar e-mail (${input.subject}): ${error.message}`);
  }
}

function send(to: string, rendered: RenderedEmail): Promise<void> {
  return sendEmail({ to, ...rendered });
}

export function sendPasswordResetEmail(
  to: string,
  params: { name?: string | null; url: string },
): Promise<void> {
  return send(
    to,
    passwordResetEmail({ ...params, ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES }),
  );
}

export function sendVerificationEmail(
  to: string,
  params: { name?: string | null; url: string },
): Promise<void> {
  return send(
    to,
    verificationEmail({ ...params, ttlHours: env.EMAIL_VERIFICATION_TTL_HOURS }),
  );
}

export function sendWelcomeEmail(to: string, params: { name?: string | null }): Promise<void> {
  return send(to, welcomeEmail({ ...params, appUrl: env.APP_URL }));
}

export function sendInvitationEmail(
  to: string,
  params: { inviterName?: string | null; workspaceName: string; url: string },
): Promise<void> {
  return send(to, invitationEmail({ ...params, ttlDays: env.INVITATION_TTL_DAYS }));
}
