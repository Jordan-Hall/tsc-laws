declare namespace JSX {
  interface IntrinsicElements {
    div: { id?: string; hidden?: boolean };
    span: { title: string };
  }
  interface Element {}
}

interface ButtonProps {
  label: string;
  disabled?: boolean;
  onClick(): void;
}

function Button(props: ButtonProps): JSX.Element {
  return <div id="x"></div>;
}

const a = <Button label="ok"  />;
const b = <div  ></div>;
const c = <span title="t" ></span>;
const d = <Button {...{ label: 'x' }}  onClick={() => {}} />;
