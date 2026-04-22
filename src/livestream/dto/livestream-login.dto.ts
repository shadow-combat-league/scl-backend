import { IsIn, IsString, MinLength } from 'class-validator'
import { LivestreamRole } from '../livestream.types'

export class LivestreamLoginDto {
  @IsString()
  @IsIn(['judge', 'overlay'])
  role: LivestreamRole

  @IsString()
  @MinLength(1)
  password: string
}
