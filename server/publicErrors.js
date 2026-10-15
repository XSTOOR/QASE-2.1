export class PublicInputError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = 'PublicInputError';
		this.status = status;
	}
}

export function publicInput(work) {
	try {
		return work();
	} catch (error) {
		if (error instanceof TypeError) throw new PublicInputError(error.message);
		throw error;
	}
}
