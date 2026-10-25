import { submit } from './submit';

export default function Page() {
  return <form action={submit}><input name="value" /><button type="submit">Submit</button></form>;
}
