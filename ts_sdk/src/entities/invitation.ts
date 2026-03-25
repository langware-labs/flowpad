// import { APIEntity, registerEntity } from '../APIEntity';
// import { TypeId } from '../FlowSync';
// import { IEntity } from '../IEntity';

// export interface IInvitationTarget {
//   typeid: string | undefined;
//   role: string;
// }

// export enum UserRole {
//   Guest = 'guest',
// }

// // export interface IInvitation extends IEntity {
// //   recipient_email?: string;
// //   // invitation_targets?: IInvitationTarget[];
// //   target_url_path?: string;
// //   accepted?: boolean;
// //   expiration_at?: Date;
// //   message?: string;
// //   sent?: boolean;
// // }

// // was Invitation. will not be saved in the DB. temporary. invitation_targets went back in it
// //@registerEntity
// export interface IMembershipRequest {
//   recipient_email: string;
//   invitation_targets: IInvitationTarget[];
//   target_url_path?: string;
//   accepted: boolean;
//   expiration_at?: Date;
//   message?: string;
//   sent: boolean;

//   // constructor(entity: Partial<IInvitation> = {}) {
//   //   super(entity);
//   //   this.recipient_email = entity.recipient_email!;
//   //   // this.invitation_targets = entity.invitation_targets ?? [];
//   //   this.target_url_path = entity.target_url_path;
//   //   this.accepted = entity.accepted ?? false;
//   //   this.expiration_at = entity.expiration_at;
//   //   this.message = entity.message;
//   //   this.sent = entity.sent ?? false;
//   // }

//   // public static async getPendingInvitation(scope: TypeId[] = []): Promise<Invitation[]> {
//   //   const query_filter = {
//   //     match: {
//   //       op: '$AND',
//   //       operands: [
//   //         {
//   //           op: '$GT',
//   //           operands: ['expiration_at', new Date()],
//   //         },
//   //         {
//   //           op: '$EQ',
//   //           operands: ['accepted', false],
//   //         },
//   //         {
//   //           op: '$EQ',
//   //           operands: ['sent', true],
//   //         },
//   //       ],
//   //     },
//   //   };
//   //   return await this.query(query_filter, scope);
//   // }

//   // public async save(scope: TypeId[] = []): Promise<Invitation> {
//   //   // TODO Why is this needed?
//   //   this.expiration_at = undefined;
//   //   return super.save(scope);
//   // }
// }
