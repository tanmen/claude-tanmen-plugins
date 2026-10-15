import type { ClientModule } from 'claude-code'

// 状態の帯の上に透明に重ねる領域。何も描かず、押されたことだけを hooks に知らせる。
// Svg は押せる要素で包めない（Button の中身は文字だけ）ので、押せる面を別に重ねている
const Hit: ClientModule<Record<string, never>, true> = (_props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'up' && event.button === 'left') surface.post({ source: 'archive-check' })
    })
    surface.setState(true)
  }
  return surface.elements.Box({})
}

export default Hit
