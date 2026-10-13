import type { ClientModule } from 'claude-code'

type HitProps = { kind: string }

// バーの上に透明に重ねる領域。何も描かず、押されたことだけを hooks に知らせる。
// Svg は押せる要素で包めない（Button の中身は文字だけ）ので、押せる面を別に重ねている
const Hit: ClientModule<HitProps, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'up' && event.button === 'left') surface.post({ kind: props.kind })
    })
    surface.setState(true)
  }
  return surface.elements.Box({})
}

export default Hit
