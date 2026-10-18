export default interface IError {
  name: string;
  message: string;
  httpStatus?: number;
  defaults?: unknown;
}
