import './styled.css';
import dot from './dot.png';

export default function StyledTemplate({ label }: { readonly label: string }) @{
  <span class="styled">{label}<img class="dot" src={dot} alt="" /></span>
}
