import { SignInHero } from '@/components/SignInHero';

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

/** Sign in with Google (SignInHero). */
export default async function Login({ searchParams }: Props) {
  const { error, next } = await searchParams;
  return <SignInHero error={error} next={next} />;
}
